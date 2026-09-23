# Release v1.3.1

## Bug Fixes

- **Image context now preserved on session resume** — Previously, when the bridge reused a cached CLI session, image descriptions weren't included in the prompt. This caused the model to act as if it couldn't see shared images on the first request, requiring a swipe to work. Fixed by extracting and prepending the SCENE IMAGES block when resuming sessions.

- **Message edits now properly detected** — Message signatures previously only included the first 200 characters, so edits to the END of messages (cutting content short) went undetected. Signatures now include first 150 chars + last 100 chars + total length, catching edits at any position.

- **Image description timeout increased** — Raised from 120s to 300s (5 minutes) to accommodate longer processing times, especially for complex images or slower models.

## Changes

- **Updated default model** to `claude-opus-4-8` (cosmetic label update; actual model resolution depends on Claude CLI support)
