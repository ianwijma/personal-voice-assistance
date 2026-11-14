/**
 * WP-5 spike (docs/VOICE-NODES.md §6, §9 M4, §12): a sherpa-onnx keyword spotter that could run on a voice node
 * so the microphone is only streamed after "hey jeff". Findings and the go / no-go: FINDINGS.md.
 */
export { keywordLine, keywordsText, loadTokenizer, makeTokenizer, normalizePhrase, type Phrase, phraseLabel, type Tokenizer, UnknownTokenError } from "./keywords.ts"
export { builtinOverrides, OovError, parseLexicon } from "./lexicon.ts"
export { defaultModelDir, isKwsModelName, type KwsModel, type KwsModelName, kwsModelNames, kwsModels, missingFile, modelPaths } from "./models.ts"
export { encode as encodeSentencePiece, parseBpeModel } from "./sentencepiece.ts"
export { createSpotter, type Fire, SAMPLE_RATE, type Spotter, type SpotterOptions } from "./spotter.ts"
