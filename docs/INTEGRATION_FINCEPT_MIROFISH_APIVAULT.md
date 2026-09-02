# Integration notes — FinceptTerminal · MiroFish · ApiVault

Cloned for reference (2026-08-27):
- https://github.com/Fincept-Corporation/FinceptTerminal.git
- https://github.com/666ghj/MiroFish.git
- https://github.com/exa-studio/ApiVault.git

## What we adopted (not forked wholesale)

### FinceptTerminal → Omnicee
| Technique | Omnicee module |
|-----------|----------------|
| OrderValidator geometry + RR | `risk-engine/fincept-order-validator.js` |
| PositionManager consecutive-loss / daily caps | `signal-pipeline/daily-gold-profile.js` + existing `drawdown-guard.js` |
| Session-aware desk | Gold peak UTC hours in daily-gold-profile |
| Broker abstraction idea | Keep MT5 EA path; no direct Fincept C++ port |

### MiroFish → Omnicee
| Technique | Omnicee module |
|-----------|----------------|
| Multi-agent swarm before decision | `signal-pipeline/mirofish-rehearsal.js` |
| Consensus gate on FIRE | Wired in `index.js` before gold desk |
| Full LLM social simulation | **Not** ported (cost + latency); optional later via AIAdvisor |

### ApiVault → Omnicee
| Technique | Omnicee module |
|-----------|----------------|
| Curated public API list | `feeds/apivault-catalog.js` |
| Prefer free FX fallbacks | Frankfurter / FreeForexAPI listed as candidates |
| Already integrated | Finnhub, FRED, CoinGecko, StockData, ExchangeRate |

## Daily trader backend policy (from Exness 223847775)

- Max ~12 trades/day hard block; warn at 8
- Consecutive losses: warn 2, hard 4
- Mandatory SL + min R:R 1.5
- Gold score floor 72
- Swarm consensus ≥ 60% for gold FIRE trust
- BUY historically stronger than SELL on this book — size down sells

