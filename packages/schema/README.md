# Conversation contract

`packages/schema/conversation.mjs` defines the framework-neutral conversation
shape shared by the AI-assisted generation flow, the deterministic renderer and
future Web/MCP/API adapters. It has no runtime dependencies and does not import
`node:` built-ins.

```js
import { validateConversationScene, ConversationSchemaError } from '../../packages/schema/conversation.mjs';

const scene = validateConversationScene(raw, { assetCount: 1, expectedPlatform: 'wechat' });
```

## Shape

```json
{
  "title": "项目群",
  "platform": "wechat",
  "deviceTime": "09:41",
  "date": "2026-01-01",
  "selfId": "me",
  "participants": [{ "id": "me", "name": "我" }, { "id": "p1", "name": "小林" }],
  "messages": [
    { "id": "m1", "participantId": "p1", "type": "text", "text": "在吗？", "time": "09:40" },
    { "id": "m2", "participantId": "me", "type": "image", "text": "这是截图", "time": "09:41", "assetIndex": 0 }
  ],
  "watermark": ""
}
```

- `platform`: `wechat` | `telegram` | `whatsapp`.
- `type`: `text` | `image` | `system` | `location`.
- `participantId` must reference a declared participant (system messages may use
  an empty string).
- `assetIndex` is only valid on `image` messages and must index into the images
  actually uploaded by the caller (`0..assetCount-1`); no remote or arbitrary
  asset references are possible.

## Bounds

| Field | Bound |
| --- | --- |
| `title` | 1–120 chars |
| `participants` | 1–12, unique safe ids |
| `messages` | 1–200, unique safe ids |
| `name` | 1–60 chars |
| `text` | ≤ 2000 chars |
| `time` / `deviceTime` | ≤ 40 chars (`deviceTime` as `HH:MM`) |
| `date` | ≤ 40 chars |
| `watermark` | ≤ 200 chars |

## Safety rules

- Text fields are rejected if they contain HTML tags, `javascript:`, `vbscript:`
  or inline event handlers. The renderer additionally HTML-escapes everything.
- Unknown participants, duplicate ids, out-of-range asset indexes, missing
  fields and oversized values all fail validation; the caller never persists an
  unvalidated scene.
- `expectedPlatform` (when provided by an explicit user choice) always wins over
  the model's `platform` value.
