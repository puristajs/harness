use std::{collections::HashMap, net::{IpAddr, Ipv4Addr}, sync::{atomic::{AtomicBool, Ordering}, Arc, LazyLock, Mutex}};

use napi::{bindgen_prelude::*, Error, Status};
use napi_derive::napi;
use regex::Regex;

static CANCELLATIONS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static EMAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}\b").expect("valid email regex"));
static PHONE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\+?[0-9][0-9 ()./-]{6,}[0-9]").expect("valid phone regex"));
static CREDIT_CARD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:[0-9][ -]?){12,18}[0-9]").expect("valid card regex"));
static IPV4: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b").expect("valid IP regex"));
static IBAN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}\b").expect("valid IBAN regex"));
static US_SSN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b").expect("valid ssn regex"));
static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"https?://[^\s<>\"']+"#).expect("valid URL regex"));

#[napi(object)]
pub struct NativeFinding {
  pub category: String,
  pub start: i64,
  pub end: i64,
  pub score: f64,
}

struct Match {
  category: &'static str,
  start: usize,
  end: usize,
  priority: u8,
}

#[napi]
pub async fn inspect(request_id: String, text: String, entities: Vec<String>, score_threshold: f64) -> Result<Vec<NativeFinding>> {
  if text.len() > 65_536 || !score_threshold.is_finite() || !(0.0..=1.0).contains(&score_threshold) {
    return Err(invalid_request());
  }
  let cancelled = Arc::new(AtomicBool::new(false));
  CANCELLATIONS.lock().map_err(|_| native_failure())?.insert(request_id.clone(), cancelled.clone());
  let result = tokio::task::spawn_blocking(move || inspect_text(&text, &entities, score_threshold, &cancelled)).await;
  CANCELLATIONS.lock().map_err(|_| native_failure())?.remove(&request_id);
  result.map_err(|_| native_failure())?
}

#[napi]
pub fn cancel(request_id: String) {
  if let Ok(cancellations) = CANCELLATIONS.lock() {
    if let Some(flag) = cancellations.get(&request_id) {
      flag.store(true, Ordering::Release);
    }
  }
}

fn inspect_text(text: &str, entities: &[String], score_threshold: f64, cancelled: &AtomicBool) -> Result<Vec<NativeFinding>> {
  let mut matches = Vec::new();
  for entity in entities {
    if cancelled.load(Ordering::Acquire) { return Err(cancelled_error()); }
    match entity.as_str() {
      "EMAIL_ADDRESS" => collect_regex(&mut matches, "EMAIL_ADDRESS", 3, &EMAIL, text, |_| true, cancelled)?,
      "PHONE_NUMBER" => collect_regex(&mut matches, "PHONE_NUMBER", 6, &PHONE, text, |_| true, cancelled)?,
      "CREDIT_CARD" => collect_regex(&mut matches, "CREDIT_CARD", 1, &CREDIT_CARD, text, is_luhn_card, cancelled)?,
      "IP_ADDRESS" => {
        collect_regex(&mut matches, "IP_ADDRESS", 2, &IPV4, text, |value| value.parse::<Ipv4Addr>().is_ok(), cancelled)?;
        collect_ipv6(&mut matches, text, cancelled)?;
      },
      "IBAN_CODE" => collect_regex(&mut matches, "IBAN_CODE", 4, &IBAN, text, |_| true, cancelled)?,
      "US_SSN" => collect_regex(&mut matches, "US_SSN", 5, &US_SSN, text, |_| true, cancelled)?,
      "URL" => collect_regex(&mut matches, "URL", 7, &URL, text, |_| true, cancelled)?,
      _ => return Err(invalid_request()),
    }
  }
  if score_threshold > 1.0 { return Ok(Vec::new()); }
  matches.sort_by(|a, b| a.start.cmp(&b.start).then(a.priority.cmp(&b.priority)).then(b.end.cmp(&a.end)).then(a.category.cmp(b.category)));
  let mut normalized = Vec::new();
  let mut last_end = 0;
  for candidate in matches {
    if candidate.start < last_end { continue; }
    last_end = candidate.end;
    normalized.push(NativeFinding { category: candidate.category.to_owned(), start: utf16_offset(text, candidate.start) as i64, end: utf16_offset(text, candidate.end) as i64, score: 1.0 });
  }
  Ok(normalized)
}

fn collect_regex<F>(matches: &mut Vec<Match>, category: &'static str, priority: u8, regex: &Regex, text: &str, accept: F, cancelled: &AtomicBool) -> Result<()>
where F: Fn(&str) -> bool {
  for found in regex.find_iter(text) {
    if cancelled.load(Ordering::Acquire) { return Err(cancelled_error()); }
    let value = &text[found.start()..found.end()];
    if accept(value) { matches.push(Match { category, start: found.start(), end: found.end(), priority }); }
    if matches.len() > 100 { return Err(invalid_request()); }
  }
  Ok(())
}

fn collect_ipv6(matches: &mut Vec<Match>, text: &str, cancelled: &AtomicBool) -> Result<()> {
  let mut start: Option<usize> = None;
  for (index, character) in text.char_indices() {
    if cancelled.load(Ordering::Acquire) { return Err(cancelled_error()); }
    if character.is_ascii_hexdigit() || character == ':' {
      if start.is_none() { start = Some(index); }
      continue;
    }
    if let Some(candidate_start) = start.take() {
      collect_ipv6_candidate(matches, &text[candidate_start..index], candidate_start)?;
    }
  }
  if let Some(candidate_start) = start {
    collect_ipv6_candidate(matches, &text[candidate_start..], candidate_start)?;
  }
  Ok(())
}

fn collect_ipv6_candidate(matches: &mut Vec<Match>, value: &str, start: usize) -> Result<()> {
  if value.len() <= 39 && value.contains(':') && matches!(value.parse::<IpAddr>(), Ok(IpAddr::V6(_))) {
    matches.push(Match { category: "IP_ADDRESS", start, end: start + value.len(), priority: 2 });
    if matches.len() > 100 { return Err(invalid_request()); }
  }
  Ok(())
}

fn is_luhn_card(value: &str) -> bool {
  let digits: Vec<u32> = value.chars().filter_map(|character| character.to_digit(10)).collect();
  if !(13..=19).contains(&digits.len()) { return false; }
  let mut sum = 0;
  for (index, digit) in digits.iter().rev().enumerate() {
    let mut current = *digit;
    if index % 2 == 1 { current *= 2; if current > 9 { current -= 9; } }
    sum += current;
  }
  sum % 10 == 0
}

fn utf16_offset(text: &str, byte_offset: usize) -> usize {
  text[..byte_offset].encode_utf16().count()
}

fn invalid_request() -> Error { Error::new(Status::InvalidArg, "Native sensitive-data request is invalid.") }
fn cancelled_error() -> Error { Error::new(Status::Cancelled, "Native sensitive-data inspection was cancelled.") }
fn native_failure() -> Error { Error::new(Status::GenericFailure, "Native sensitive-data inspection failed.") }
