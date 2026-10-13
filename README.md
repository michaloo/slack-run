# slack-run

Run commands from Slack messages. Rules in a YAML file say which messages (mention, channel
message or DM; which channels and users; a regex) run which commands, and where the output goes.
It connects with Slack **Socket Mode**, an outbound WebSocket, so it needs no public URL.

Node 24+; TypeScript runs directly, with no build step.

```sh
npm install
cp examples/simple.yaml slack-run.yaml            # edit
export SLACK_APP_TOKEN=xapp-… SLACK_BOT_TOKEN=xoxb-…
node src/main.ts check                            # validate the config
node src/main.ts simulate --text "deploy staging" --user U0123456 --channel C0123456   # dry run
node src/main.ts serve                            # connect to Slack
```

## Config

```yaml
slack:
  appToken: ${SLACK_APP_TOKEN}    # ${VAR} is read from the environment
  botToken: ${SLACK_BOT_TOKEN}
state: state.json                 # per-thread captured values

rules:                            # the first rule that matches wins
  - name: deploy
    on:
      event: mention              # mention (default) | message | dm | any
      channels: [C0123456]        # optional
      users: [U0123456]           # required, unless you set anyone: true
      match: '^deploy (?<env>staging|prod)$'   # optional regex; named groups become variables
      thread: any                 # new | existing (has captured state) | any
    steps:                        # run in order; stops at the first non-zero exit
      - run: ./scripts/deploy.sh {env}         # or a list: [./scripts/deploy.sh, "{env}"]
        cwd: /srv/app
        timeout: 15m              # default 10m
        env: { TARGET: "{env}" }
        stdin: "{text}"           # optional
        capture: { release: '^release: (\S+)$' }   # remembered for this thread as {release}
    reply: last-step              # last-step (default) | all | none
    errors: post                  # post (default) | react (reaction only)
    reactions: { start: rocket, done: white_check_mark, error: x, exit3: hourglass }
```

**Variables**: `{text}` (the message without the bot mention), `{user}`, `{channel}`, `{ts}`,
`{thread}`, `{event}`, named regex groups, and values captured earlier in the same thread. They
are also exported to commands as `SLACK_TEXT`, `SLACK_USER`, and so on.

**Safety**: a command string is split into arguments first, and variables are substituted into
each argument afterwards. Commands run without a shell, so Slack text can't inject shell syntax.
Every rule must list `users` (or opt into `anyone: true`), because these commands run on your
machine.

**Threads**: runs in the same thread are serialised. Retried Slack deliveries are ignored. Long
replies are split into several messages.

## Examples

- `examples/simple.yaml`: a DM command and a channel deploy.
- `examples/casm.yaml`: casm coding agents, one per Slack thread. The first mention runs
  `casm run` and captures the agent id; follow-ups in the thread run `casm send {agent}`.
- `examples/slack-app-manifest.yml`: the Slack app (scopes, events, Socket Mode).
- `examples/slack-run.service`: a systemd user unit.

A Slack app spreads Socket Mode events across all its open connections. Use a separate Slack app
for slack-run instead of sharing one with another Socket Mode consumer (such as Paseo Hub).
