# Voice Input

The plugin behind Gode's dictation. It offers the `dictation` capability (see the SDK guide, `packages/plugin-sdk/README.md` in the Gode repository) and turns a recording into text, either on the computer or through a speech server the person names. Gode owns the global shortcut, recording, the bar that shows recognition progress, the vocabulary list and typing the text into whichever app the person is using.

## Recognition

The Recognize On setting chooses the engine:

- **This Computer** (the default) runs the selected local model through llama.cpp's `llama-server`. Qwen3-ASR 1.7B is recommended for the best recognition (2.5 GB download); Qwen3-ASR 0.6B is faster and needs less memory and disk space (1.0 GB download). The archive carries `llama-server` and its libraries for the platform. Download Model fetches only the selected model and its audio projector into `paths.data/models` as `.partial` files, checks them against the SHA-256 pins in `resources.json`, then gives them their final names. An interrupted download starts over. Both model sets can remain on disk; Remove Model removes only the selected set. `llama-server` starts on `127.0.0.1` when a recording starts and stops a minute after the last recording ends. Changing the local model stops the current engine and starts the selected model on the next recording.
- **OpenAI-Compatible Server** sends the recording to any OpenAI-compatible `/audio/transcriptions` endpoint, such as OpenAI's or a speech server on the local network, with the URL, API key and model the person gives. Check Server lists the server's models to confirm the URL and key.

Both engines receive the language setting (Automatic or one language). Only an OpenAI-compatible server receives the person's vocabulary and Gode's request vocabulary, up to 50 of the person's words, as the `prompt`. The local model does not use the prompt for vocabulary recognition and can echo it as speech, so the plugin omits it. After recognition, and after tidying up, both engines use the vocabulary to rewrite words the model spelled out, split or joined differently, such as `G O D E` or `assistant UI`, as written in the vocabulary, leaving a word that differs only in case as heard. A term of several words is also restored where the model heard some of its words as similar ones and at least one as written, such as `Cloud Code` for `Claude Code`; a similar word said on its own, such as `cloud`, stays as heard. Remove Filler Words drops sounds such as “um” and “嗯”.

Speech detection skips silence, steady background noise and brief clicks before recognition to reduce invented text when nobody speaks. Recordings need at least 250 ms of detected speech; otherwise the plugin returns empty text without a recognition request or a statistics entry. Local recognition receives the detected span with 300 ms of padding, while a server receives the full recording.

## Tidy up

Tidy Up with a Model offers Qwen3.5 4B on this computer (2.7 GB download, the default), Qwen3.5 2B on this computer (1.3 GB download), or an OpenAI-compatible chat service the person chooses, such as DeepSeek. The local tidy-up model starts with a recording and stops once its dictation is typed. The whole dictation is tidied once when it finishes. The model's reply is typed only when it reads as an edit of what was said; otherwise the recognized text is typed. When the person chooses a service, the transcript and vocabulary are sent to it.

## Previews

Each recording starts a dictation session. With This Computer, the plugin warms the model when the session starts, then checks for a preview after each additional second of audio, up to 30 seconds, and recognizes only when speech is detected. It returns the same cleanup and vocabulary corrections used for the final result. A server returns no interim text because each request may be charged. Finishing the session stops any recognition in progress, checks the complete recording for speech and returns the final text Gode types. Cancelling the session stops its recognition work.

## Statistics

Every successful final transcription with non-empty text adds its word count, recorded audio duration and one dictation to the current local date. Each CJK ideograph, kana and Hangul syllable counts as one word; each run of other letters or digits counts as one, allowing apostrophes inside. Punctuation and whitespace do not count. Previews, failed transcriptions and empty results do not count.

Statistics are stored in `stats.json` in the plugin's data folder, using atomic writes. The plugin retains daily entries for the last 400 days and all-time totals; a missing or corrupt file starts empty. The Usage figures show today's words, total words, total speaking time and total dictations. The Activity calendar shows words per day. Both views are sent at startup, after every counted transcription and when the local date changes.

## History

Keep Dictation History is on by default. Each non-empty final transcription saves its text, timestamp and recording length in `history.json` under `paths.data`, on this computer. The newest 10,000 entries are kept; audio is not saved. Dictation History shows recent entries newest first, with recording lengths in the plugin's language. Gode opens the full history on its own page with search and pages of entries. Turn the setting off to stop saving new entries while keeping existing ones, use Delete to remove one, or Clear History to remove all. Transcriptions longer than 10,000 characters remain complete on disk but show only their first 10,000 characters in the list.

## Vocabulary

Suggest Vocabulary is on by default. The plugin extracts Latin words of at least three letters from text containing Chinese, Japanese or Korean, code identifiers and acronyms, but not capitalized words in Latin text, because recognition capitalizes words it mishears. It excludes common English words, pure numbers and words the person added or supplied in the request vocabulary. Terms are matched without regard to case, and the most frequently heard spelling is kept. Repetitions within one dictation count as one dictation; a term becomes a suggestion after two separate dictations. At most 300 suggestions are kept, with the least recently heard removed first. A suggestion never reaches recognition, tidying up or a server until the person adds it to the vocabulary.

The Vocabulary view shows the words the person added as tokens; they take priority over request words and are never pruned. Suggested Terms lists the suggestions newest first with how many dictations each was heard in: Add to Vocabulary moves one into the vocabulary, and Ignore drops it. Removing a word or ignoring a suggestion prevents it from being suggested again until the person adds it or clears the vocabulary. The words, candidates, spelling frequencies, dictation counts and forgotten terms are stored in `memory.json` under `paths.data`; the vocabulary syncs through the stores when Sync Vocabulary is on. The vocabulary helps recognition on this computer and is included in requests to a server. Turning Suggest Vocabulary off stops new suggestions while continuing to use the vocabulary. Clear Vocabulary removes all words, suggestions, candidates and forgotten terms. History and vocabulary use atomic writes; a failed write never fails or delays dictation.

## Files

| Path | What it holds |
| --- | --- |
| `plugin.json` | Identity, compatibility and software credits. |
| `page/` | Settings, actions and views. |
| `i18n/` | Words in every language. |
| `resources.json` | The pinned model sets and `llama-server` archives, by URL, size and SHA-256. `setupBytes` in `plugin.json` is the default model set's total size, and the build checks that it matches. |
| `src/main.ts` | The process entry, which hands `createVoicePlugin` to `definePlugin`. |
| `src/plugin.ts` | Settings, secrets, paths and service wiring. |
| `src/status.ts` | Statuses, setup steps and status publishing. |
| `src/models/` | Model downloads, removals, checksum checks and the local `llama-server`. |
| `src/recognition/` | Dictation sessions, previews, local and server recognition, server checks, polish and speech detection. |
| `src/data/` | History, vocabulary and suggestions, statistics and their shared atomic persistence. |
| `test/` | Tests mirroring the source areas, with whole-plugin tests grouped by aspect in `plugin/`. |
| `build.ts` | Fetches the pinned `llama-server` for each platform and stages its runtime files for the SDK build. |

## Commands

```sh
pnpm --dir plugins/voice-input test
pnpm --dir plugins/voice-input check
pnpm --dir plugins/voice-input build [platform...]   # archives in out/, llama.cpp downloads cached in out/.cache
```

The build downloads `llama-server` with `gh release download`, so it needs the GitHub CLI signed in. On Linux, `llama-server` also needs `libgomp1`.
