# Working in this repository as an agent

The process is [CONTRIBUTING.md](CONTRIBUTING.md), and it applies in full: plan first and wait for a yes, tests first and seen failing, every suite before a pull request, the docs in the same pull request, one pull request at a time, never a push to `main`. This file is only what an agent's environment adds to it.

- **Plan first, wait for a yes** holds for an agent as for anyone: the README paragraph and the tests by name, in the conversation, before any code.
- **Long suites go in the background.** A suite longer than one tool call allows (two-tabs, page-publish; `npm test` as a whole):

  ```bash
  nohup npm run test:suite -- two-tabs page-publish > /tmp/suites.log 2>&1 &
  ```

  then poll the log for its `=== Summary` block. (The integrity suite's fixtures print "suites failed" on purpose: wait for the summary, not for those words.)
- **The cloud environment** has no Playwright browser of its own: `CHROMIUM_PATH=/opt/pw-browsers/chromium` before a browser suite or `npm run screenshot`. It has 2 CPUs: `npm test -- --parallel 2` there, no more. A machine with CPUs to spare bears every suite at once (`--parallel 18`); a failure seen only in such a run is rerun alone before anything is read into it.
- **Report what was verified, with its output.** A suite that failed, a step skipped, a check seen red: said as it happened. A result reported as better than it was is worse than no run.
