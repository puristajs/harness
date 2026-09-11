import { BaseModelProvider } from '../src/ports/base-model-provider.js'
import type { ModelProvider, TextRequest, TextResponse } from '../src/ports/model-provider.js'

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Expect<Value extends true> = Value
type IsOptional<Value, Key extends keyof Value> = {} extends Pick<Value, Key> ? true : false

type _baseTextOptional = Expect<Equal<IsOptional<BaseModelProvider, 'text'>, true>>
type _baseTextStreamOptional = Expect<Equal<IsOptional<BaseModelProvider, 'textStream'>, true>>
type _baseObjectOptional = Expect<Equal<IsOptional<BaseModelProvider, 'object'>, true>>
type _baseObjectStreamOptional = Expect<Equal<IsOptional<BaseModelProvider, 'objectStream'>, true>>
type _baseEmbedOptional = Expect<Equal<IsOptional<BaseModelProvider, 'embed'>, true>>
type _baseRerankOptional = Expect<Equal<IsOptional<BaseModelProvider, 'rerank'>, true>>
type _baseImageOptional = Expect<Equal<IsOptional<BaseModelProvider, 'image'>, true>>
type _baseSpeechOptional = Expect<Equal<IsOptional<BaseModelProvider, 'speech'>, true>>
type _baseVideoOptional = Expect<Equal<IsOptional<BaseModelProvider, 'video'>, true>>
type _baseVideoStreamOptional = Expect<Equal<IsOptional<BaseModelProvider, 'videoStream'>, true>>

declare const baseProvider: BaseModelProvider
// @ts-expect-error an unrefined BaseModelProvider does not promise text support
const requiredTextProvider: Readonly<{ text: NonNullable<ModelProvider['text']> }> = baseProvider
void requiredTextProvider

class TextProvider extends BaseModelProvider {
  public declare readonly text: NonNullable<ModelProvider['text']>
  protected override doText = async (_request: TextRequest): Promise<TextResponse> => ({
    content: 'ok', usage: { inputTokens: 0, outputTokens: 1, totalTokens: 1 }, finishReason: 'stop',
  })

  public constructor() {
    super({ id: 'typed-text', genAiSystem: 'test' })
    this.finalizeOperations()
  }
}

declare const request: TextRequest
const response: Promise<TextResponse> = new TextProvider().text(request)
void response
