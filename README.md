# PeerInfinity fork — Idle Loops (substrate/automation)

This is an independent fork of [dmchurch/omsi-loops](https://github.com/dmchurch/omsi-loops)
(itself a fork of lloyd-delacroix's and omsi6's Idle Loops lineage), built on
cirne's public 2024-03-11 grant to use their code for any purpose. It adds,
behind default-off toggles, an **Advanced Automation** queue planner
(algorithm explained in detail in [AUTOMATION.md](AUTOMATION.md)), smaller
stand-alone assist tools (currently the **rep-gap report**: a predictor-side
annotation showing when an action has fewer reps queued than the current
state could execute next loop — Extras menu → predictor settings), and (in
progress) integration hooks for the Archipelago randomizer, plus a headless
test suite (`npm test`) that locks all 157 action `varName`s (save-format
compatibility) and the sim's deterministic behavior.

**AI disclosure & verification:** substantial parts of this fork are written
with AI tooling (Claude). The correctness story is machine-checked rather
than asserted: a differential parity harness proves the fork at default
settings stays byte-identical to the upstream fork point (`fe4a349`)
tick-for-tick, goldens freeze the save-format-bearing action shapes, and the
planner reproduces its reference playthrough deterministically. Commits
carry their provenance in the log.

---

:ok_hand: :ok_hand: :ok_hand: :ok_hand: :ok_hand: :ok_hand: :ok_hand: :ok_hand: :ok_hand: :ok_hand: 

##Local Development
 - **Fork** the repository into your own account
 - Download VSCode and pull the repo locally
 - Download "Live Server" extension in VSCode.
  - When on the index.html file, hit the "Go Live" button at the bottom right.
  - This will allow you to quickly see changes locally on the web browser that is opened.

 - Hosting in Github Pages
  - On the repo, go to "Settings" -> "Pages"
  - Follow on screen instructions to host the **branch** that you want to show, and once complete, it will give you a link at the top of the page to go to to see changes.
   - Note: This may take >10 minutes to reflect changes, so its not good for testing. But it is good for playing!
