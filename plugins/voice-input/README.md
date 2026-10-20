# Voice Input

The plugin behind Gode's dictation. It offers the `dictation` capability (see the SDK guide, `packages/plugin-sdk/README.md` in the Gode repository) and turns a recording into text, either on the computer or through a speech server the person names. Gode owns the global shortcut, recording, the bar that shows recognition progress, the vocabulary list and typing the text into whichever app the person is using.

## Recognition

The Recognize On setting chooses the engine:

- **This Computer** (the default) runs Qwen3-ASR 1.7B through llama.cpp's `llama-server`. The archive carries `llama-server` and its libraries for the platform; the model and its audio projector (2.5 GB together) download into the plugin's data folder when the person runs Download Model, as `.partial` files that are checked against the SHA-256 in `resources.json` before taking their names; an interrupted download starts over. `llama-server` starts on `127.0.0.1` at the first recording and stops after five idle minutes.
- **OpenAI-Compatible Server** sends the recording to any OpenAI-compatible `/audio/transcriptions` endpoint, such as OpenAI's or a speech server on the local network, with the URL, API key and model the person gives. Check Server lists the server's models to confirm the URL and key.

Both engines receive the language setting (Automatic or one language). Only an OpenAI-compatible server receives Gode's vocabulary and up to 50 learned terms, ranked by dictation count, as the `prompt`. The local model does not use the prompt for vocabulary recognition and can echo it as speech, so the plugin omits it. After recognition, both engines use the full vocabulary and all learned terms to rewrite words the model spelled out or split, such as `G O D E`, as written in the vocabulary. Remove Filler Words drops sounds such as “um” and “嗯”.

Speech detection skips silence, steady background noise and brief clicks before recognition to reduce invented text when nobody speaks. Recordings need at least 250 ms of detected speech; otherwise the plugin returns empty text without a recognition request or a statistics entry. Local recognition receives the detected span with 300 ms of padding, while a server receives the full recording.

## Previews

Each recording starts a dictation session. With This Computer, the plugin warms the model when the session starts, then checks for a preview after each additional second of audio, up to 30 seconds, and recognizes only when speech is detected. It returns the same cleanup and vocabulary corrections used for the final result. A server returns no interim text because each request may be charged. Finishing the session stops any recognition in progress, checks the complete recording for speech and returns the final text Gode types. Cancelling the session stops its recognition work.

## Statistics

Every successful final transcription with non-empty text adds its word count, recorded audio duration and one dictation to the current local date. Each CJK ideograph, kana and Hangul syllable counts as one word; each run of other letters or digits counts as one, allowing apostrophes inside. Punctuation and whitespace do not count. Previews, failed transcriptions and empty results do not count.

Statistics are stored in `stats.json` in the plugin's data folder, using atomic writes. The plugin retains daily entries for the last 400 days and all-time totals; a missing or corrupt file starts empty. The Usage figures show today's words, total words, total speaking time and total dictations. The Activity calendar shows words per day. Both views are sent at startup, after every counted transcription and when the local date changes.

## History

Keep Dictation History is on by default. Each non-empty final transcription saves its text, timestamp and recording length in `history.json` under `paths.data`, on this computer. The newest 200 entries are kept; audio is not saved. Dictation History shows entries newest first, with recording lengths in the plugin's language. Turn the setting off to stop saving new entries while keeping existing ones, use Delete Entry to remove one, or Clear History to remove all. Transcriptions longer than 10,000 characters remain complete on disk but show only their first 10,000 characters in the list.

## Memory

Learn Terms is on by default. The plugin extracts Latin words of at least three letters from text containing Chinese, Japanese or Korean, code identifiers and acronyms, but not capitalized words in Latin text, because recognition capitalizes words it mishears. It excludes common English words, pure numbers and terms already in the request vocabulary. Terms are matched without regard to case, and the most frequently heard spelling is kept. Repetitions within one dictation count as one dictation; a term becomes learned after two separate dictations. At most 300 learned terms are kept, with the least recently heard removed first.

Candidates, spelling frequencies, dictation counts and forgotten terms are stored in `memory.json` under `paths.data`, on this computer. Learned terms help recognition as described above and are included in requests when using a server. Turn Learn Terms off to stop learning while continuing to use existing terms. Forget Term removes a term and prevents it from being learned again, including after a restart. Clear Memory removes all candidates, learned terms and forgotten terms, allowing learning to start fresh. History and memory use atomic writes; a missing or corrupt file starts empty, and a failed write never fails or delays dictation.

## Files

| Path | What it holds |
| --- | --- |
| `manifest.json` | Settings, actions, views, statuses and their words in every language. |
| `resources.json` | The pinned model files and `llama-server` archives, by URL, size and SHA-256. `setupBytes` in the manifest is the models' total size, and the build checks that it matches. |
| `src/main.ts` | The process entry, which hands `createVoicePlugin` to `definePlugin`. |
| `src/plugin.ts` | Settings, actions, statuses and the `dictation` calls. |
| `src/engine.ts` | Starts and stops the local `llama-server`. |
| `src/download.ts` | Model downloads and their checksum checks. |
| `src/transcription-logic.ts` | The transcription request, and cleanup of what comes back. |
| `src/speech-logic.ts` | Speech detection from PCM energy, zero crossings and duration. |
| `src/stats.ts` | Word and audio counts, persistent daily statistics and SDK views. |
| `src/history.ts` | Saved dictations and the history list. |
| `src/memory.ts` | Learned terms, forgotten terms and the memory list. |
| `src/memory-logic.ts` | Candidate term extraction. |
| `src/atomic-file.ts` | Serialized atomic persistence shared by statistics, history and memory. |
| `scripts/build.mjs` | Fetches the pinned `llama-server` for each platform, bundles `src/main.ts` and packs the archive with `packPlugin`. |

## Commands

```sh
pnpm --dir plugins/voice-input test
pnpm --dir plugins/voice-input typecheck
pnpm --dir plugins/voice-input build [platform...]   # archives in out/, llama.cpp downloads cached in out/.cache
```

The build downloads `llama-server` with `gh release download`, so it needs the GitHub CLI signed in. On Linux, `llama-server` also needs `libgomp1`.
