package purista.bank.transfer

default decision := {
  "matched": true,
  "effect": "deny",
  "ruleId": "opa_transfer_default_deny",
  "reasonCode": "policy_default_deny",
}

decision := {
  "matched": true,
  "effect": "allow",
  "ruleId": "opa_transfer_allow",
  "reasonCode": "policy_allow",
} if {
  input.tool == "transfer_funds"
  input.amount <= 1000
  startswith(input.destination, "acct_")
}

decision := {
  "matched": true,
  "effect": "deny",
  "ruleId": "opa_transfer_limit",
  "reasonCode": "transfer_limit",
} if {
  input.tool == "transfer_funds"
  input.amount > 1000
}
