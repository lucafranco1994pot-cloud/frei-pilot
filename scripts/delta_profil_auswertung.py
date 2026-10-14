"""Auswertung nach ergebnisse/delta-profil-vorregistrierung.md."""
from pathlib import Path
import numpy as np
import pandas as pd
from freqtrade.data.btanalysis import load_backtest_data
from freqtrade.data.history import load_pair_history
from freqtrade.enums import CandleType

UD = Path('ud')
VARIANTS = ['ST_start100', 'ST_m1p', 'ST_m1m', 'ST_p1p', 'ST_p1m', 'ST_p2p', 'ST_p2m']
TEST_START = pd.Timestamp('2024-01-01', tz='UTC')

base = load_backtest_data(UD / 'backtest_results', strategy='ST_base')
keys = lambda t: set(zip(t.pair, t.open_date))
var_keys = [keys(load_backtest_data(UD / 'backtest_results', strategy=v)) for v in VARIANTS]
base['stability'] = [sum((p, d) in vk for vk in var_keys) / len(VARIANTS)
                     for p, d in zip(base.pair, base.open_date)]

# Volumen der Signalkerze (Kerze vor dem Einstieg)
vols = []
for pair, grp in base.groupby('pair'):
    df = load_pair_history(pair=pair, timeframe='1h', datadir=UD / 'data' / 'binanceus',
                           candle_type=CandleType.SPOT).set_index('date')
    for idx, od in zip(grp.index, grp.open_date):
        vols.append((idx, df['volume'].get(od - pd.Timedelta(hours=1), np.nan)))
base['volume'] = pd.Series(dict(vols))
base['loss'] = base.profit_abs < 0

learn = base[base.open_date < TEST_START].copy()
test = base[base.open_date >= TEST_START].copy()
med = learn.groupby('pair').volume.median()
for d in (learn, test):
    d['vol_rank'] = d.volume / d.pair.map(med)

# Schwelle S nur auf Lernzeitraum: kleinste Stabilitaet, bei der hoechstens ~50 % bleiben
S = None
for s in sorted(learn.stability.unique()):
    if (learn.stability >= s).mean() <= 0.5:
        S = s
        break
if S is None:
    S = learn.stability.max()

c = test[test.stability >= S]
n = len(c)
b = test.sort_values('vol_rank', ascending=False).head(n)

def line(name, d):
    return f"{name:<34} n={len(d):4d}  Verlustquote={d.loss.mean():6.1%}  Ø Gewinn={d.profit_abs.mean():7.3f} USDT"

rng = np.random.default_rng(1)
rand = np.array([test.loss.sample(n, random_state=int(rng.integers(10**9))).mean() for _ in range(10000)]) if n else np.array([1.0])
p = (rand <= c.loss.mean()).mean() if n else 1.0

print(f"Trades gesamt {len(base)}  Lernzeit {len(learn)}  Test {len(test)}")
print(f"Schwelle S = {S:.3f} (Anteil im Lernzeitraum: {(learn.stability >= S).mean():.1%})")
print("Stabilitaet im Test (Anzahl Trades je Wert):", test.stability.round(3).value_counts().sort_index().to_dict())
print("--- Lernzeitraum (nur zur Info)")
print(line('A alle', learn))
print(line('C stabil (>= S)', learn[learn.stability >= S]))
print(line('  wacklig (< S)', learn[learn.stability < S]))
print("--- TEST 2024 (blind)")
print(line('A alle', test))
print(line('B Volumen-Regel (gleiche Anzahl)', b))
print(line('C Delta-Profil (>= S)', c))
print(line('  wacklig (< S)', test[test.stability < S]))
print(f"Placebo: Anteil zufaelliger Auswahlen mit Verlustquote <= C: {p:.3f}")
ok = n > 0 and c.loss.mean() < b.loss.mean() and c.loss.mean() < test.loss.mean() and p < 0.05
print("ERGEBNIS:", "ERFOLG nach Vorregistrierung" if ok else "KEIN Zusatznutzen nachgewiesen")
