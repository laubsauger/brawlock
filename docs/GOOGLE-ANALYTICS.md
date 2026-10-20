# Product and acquisition analytics

GA4 complements the private operational report: use GA4 for acquisition and opted-in player funnels; use `npm run analytics` for authoritative dedicated-game totals, including people who decline Google tracking. Client events are player participations, not unique global matches or authoritative results. Reconnects/reloads can produce another participation event. The two systems do not exchange identity IDs.

## Activate

Configured on 2026-10-20: **Brawlock Web**, stream `16167604220`, Measurement ID `G-CDJDFJT3ZJ`, URL `https://brawlock.osc.link`. The owner confirmed Enhanced measurement is off. Client deployment and post-deploy Realtime verification are still required; receiving an ID does not establish live collection.

1. Open https://analytics.google.com/ (separate from Google Cloud Console). Create a Brawlock GA4 property and Web stream for `https://brawlock.osc.link`.
2. **Turn Enhanced measurement off** in the Web stream. We send explicit, sanitized SPA page views and product events; automatic history/form/outbound tracking can collect unintended URL or form context and duplicate page views. Keep Google signals, user-provided data collection, advertising personalization and Ads linking off.
3. Copy the public Measurement ID (`G-…`) into `measurementId` in `src/lib/analyticsConfig.ts`. `null` deliberately disables the integration. The canonical origin guard excludes local previews and other sites. This checked-in public configuration is identical in CI and fleet builds; no API secret or new server service is required.
4. Review/release the client and updated privacy notice normally. No Analytics tag is injected in `index.html`, and no Analytics script or tracking request is sent before a player's opt-in. Both choices are presented together. The preference is saved with existing settings and can be changed under Settings → Interface. Existing Google sign-in/font requests are independent of analytics.
5. On the deployed site, choose Allow analytics, then check **Reports → Realtime** for page views, tutorial and match events. Use **Admin → DebugView** with Google Tag Assistant when debugging; exclude developer traffic from production reporting. Verify separately that declining leaves no Google script or collect requests.

This change does not create the GA property, register reporting dimensions, or deploy itself. Live collection needs the actual Measurement ID and a release. Ad blockers, consent choices and blocked Google endpoints mean GA totals are not complete population counts. There is no retrospective sending of pre-consent gameplay events.

## Events and funnels

| Event | Trigger |
| --- | --- |
| `page_view` | Initial opt-in/load and actual screen changes; `screen_name` identifies the SPA screen |
| `how_to_play_view` | Overview opened from the menu or a first-play interception; `entry_point` distinguishes them |
| `how_to_play_exit` | Overview continued, closed or left for practice (`choice`), with its `entry_point`; this does **not** count as lesson completion |
| `how_to_play_lesson_view` | Which overview lesson is shown (`lesson`), with its `entry_point` |
| `how_to_play_clip_start` | A clip actually emits `playing`, once per lesson visit. `playback` separates autoplay from manual playback; neither proves the full clip was watched |
| `guided_practice_click` | The player chooses Start guided practice, with its `entry_point`; separate from successfully starting the lesson |
| `tutorial_begin` | Guided practice actually starts |
| `tutorial_step` | A new lesson step: `move`, `fireball`, `shop`, `teleport`, `lava` |
| `tutorial_complete` | The real lesson reaches its completed state |
| `tutorial_exit` | Practice left before completion, with its last `step` |
| `match_start` | Actual match recorder starts for a local participant, including offline games; excludes spectators, replays and guided practice. Includes `mode`, `transport`, `players`, `bots` |
| `match_complete` | A played match yields a result; `mode`, `outcome`, `rounds`, `duration_seconds` |
| `match_exit` | A participant's active match recorder is aborted without a result; `mode` |

Events carry `app_version` and `player_type` (`guest`/`account`), with no game/account/device IDs, names, emails, chat or raw invite/auth URLs. Referral data contains only the referring origin. Landing URLs retain only valid `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `utm_id` values. We do not set GA User-ID or submit account identity to Google.

Every match event retains its starting `mode`: `ranked`, `casual` (Quick Play), `custom`, or `offline`. Use `mode` to compare starts, completions and early exits by ranked/casual, including within each campaign. Changing lobby/menu state after a match begins does not relabel its completion or exit.

For copy/layout decisions, compare menu `page_view` → `how_to_play_view` filtered to `entry_point=menu` (people who found the menu action). Analyze `first_play` separately: an automatic prompt is not evidence that someone found the button. Then compare overview lesson views → `guided_practice_click` → `tutorial_begin` → step progression → `tutorial_complete`. A click without a start can indicate an entry/ownership failure; a start without completion indicates practice drop-off. Tutorial overview lessons are `fireball` (Push), `teleport` (Escape), `shield` (Defend) and `lightning` (Build).

Compare users/session funnels rather than raw event totals: people can reopen the guide or retry practice. These funnels cover opted-in visitors only. Local production-build browser proof is retained in ignored `artifacts/analytics/qa/`: declining loaded no Analytics SDK; allowing loaded one configured tag and produced separate menu guide, lesson, actual clip playback, practice-click and practice-start events. Google requests were intercepted during QA, so this proves browser wiring without sending synthetic data to the live property; it does not replace post-deploy Realtime verification.

In **Admin → Data display → Custom definitions**, add event-scoped dimensions `screen_name`, `entry_point`, `choice`, `lesson`, `playback`, `step`, `mode`, `transport`, `player_type`, `app_version`, `outcome`. Add custom metrics `players`, `bots`, `rounds`, `duration_seconds` if needed. In Explore, build an open funnel: `page_view` (menu) → `tutorial_begin` → `tutorial_complete` → `match_start` → `match_complete`; an open funnel lets experienced players skip the tutorial. Mark `tutorial_complete` and `match_start` as key events to compare acquisition quality, with completion as the stricter engagement metric.

Campaign example:

```text
https://brawlock.osc.link/?utm_source=x&utm_medium=social&utm_campaign=prealpha_launch&utm_content=gameplay_clip
```

Use separate `utm_content` values for each clip/post and consistent lowercase source/medium names. Compare Session source/medium/campaign in Traffic acquisition against tutorial completion and match participation, rather than just visits. Realtime shows recent activity; acquisition reports and new custom definitions take time to populate. Google Analytics measures device/browser geography and traffic according to its own processing; nothing in this implementation claims every visitor can be identified or counted.

References: [GA4 setup](https://support.google.com/analytics/answer/14183469), [manual page views](https://developers.google.com/analytics/devguides/collection/ga4/views), [recommended tutorial events](https://developers.google.com/analytics/devguides/collection/ga4/reference/events#tutorial_begin), [Google tag opt-out](https://developers.google.com/tag-platform/security/guides/privacy).
