# First-play guide and hands-on practice

The first play action still opens How to play **before** matchmaking, hosting or joining. The guide's primary action starts a short offline lesson; skipping explicitly continues the selected action, while closing it returns to the menu. Choosing practice cancels the intercepted action, including an invite, so no seat or lobby is reserved in the background. The guide remains available from the main menu after dismissal.

The lesson checks actual simulation outcomes:

1. Right-click and walk to the gold ring.
2. Aim and hit a stationary dummy with Fireball.
3. Buy Teleport in the real shop's Transport column, using real gold and purchase rules.
4. Use Teleport to land at the marked location.
5. Hit a dummy near the edge and cause a real lava knockout.

Prompts use the current key bindings and cast mode. Checkboxes advance from movement, damage, purchase, teleport and death events rather than raw key presses. The shop has no timer; unrelated purchases are visibly disabled for this lesson. Short practice cooldowns and a rescue after falling in lava allow retries. There is a leave button throughout and the ordinary Escape pause menu. Completion offers a normal offline match against two Easy bots or a return to the menu.

`practiceScenario.ts` owns this private simulation. `practice.ts` connects it to the existing fixed-step clock, input, audio and render buffer; no regional room, account reward, career record or replay recorder is opened. Normal matchmaking, prices, damage and bot behavior are unchanged. Switching screens or starting another session stops the lesson clock and clears its render buffer.

The gold target reuses the existing move-marker material and adds one lazily allocated quad during practice. It adds no texture, render pass or regular-match draw submission. Tutorial controls use the existing game widgets and shop cards.

Focused tests cover the full real-simulation lesson, misses, incorrect purchases/landings, untimed shopping, lava rescue, pause/exit/restart cleanup and cancellation of intercepted play/invite actions. Browser evidence is kept locally under ignored `artifacts/guided-practice/`.

Verification status: focused tests, TypeScript and a production build pass. The final desktop browser check completed the full lesson with real right-click movement, keyboard Fireball and Teleport casts, an actual shop purchase and a lava knockout. Exit cleared the lesson/frame, left career statistics unchanged and made no matchmaking requests; no runtime errors were recorded. Captures and proof remain in the ignored evidence directory. The transparent chat-layout wrapper passes through arena clicks while menus explicitly receive them.
