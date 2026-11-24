# token-radar-01
[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/liuwenfeng-lwf123/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/liuwenfeng-lwf123/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads a frozen DefiLlama protocol snapshot, ranks every pre-token protocol by an implied launch value built from its own TVL, 7-day growth, age with no token and chain reach, gives each one a concrete 7-step farm plan with costs and times, and serves it all as an offline dashboard.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

Then open `out/dashboard/index.html` in a browser. Node 22 or later, standard library only, no network.

<sub>Entered on [make.fun](https://make.fun/?ref=cvt89r1n&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
