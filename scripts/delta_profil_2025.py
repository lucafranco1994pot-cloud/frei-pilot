"""Auswertung nach ergebnisse/delta-profil-2025-vorregistrierung.md."""
from pathlib import Path
import numpy as np
import pandas as pd
from freqtrade.data.btanalysis import load_backtest_data
from freqtrade.data.history import load_pair_history
from freqtrade.enums import CandleType

UD = Path('ud')
VARIANTS = ['ST_start100', 'ST_m1p', 'ST_m1m', 'ST_p1p', 'ST_p1m', 'ST_p2p', 'ST_p2m']
S = 1.0
LEARN = (pd.Timestamp('2022-01-01', tz='UTC'), pd.Timestamp('2024-01-01', tz='UTC'))
Y2024 = (pd.Timestamp('2024-01-01', tz='UTC'), pd.Timestamp('2025-01-01', tz='UTC'))
Y2025 = (pd.Timestamp('2025-01-01', tz='UTC'), pd.Timestamp('2026-01-01', tz='UTC'))

res = UD / 'backtest_results'
base = load_backtest_data(res, strategy='ST_base')
var_keys = [set(zip(t.pair, t.open_date)) for t in (load_backtest_data(res, strategy=v) for v in VARIANTS)]
base['stability'] = [sum((p, d) in vk for vk in var_keys) / len(VARIANTS) for p, d in zip(base.pair, base.open_date)]
base['loss'] = base.profit_abs < 0

feats = []
for pair, grp in base.groupby('pair'):
    df = load_pair_history(pair=pair, timeframe='1h', datadir=UD / 'data' / 'binanceus',
                           candle_type=CandleType.SPOT).set_index('date')
    pc = df.close.shift(1)
    tr = pd.concat([df.high - df.low, (df.high - pc).abs(), (df.low - pc).abs()], axis=1).max(axis=1)
    df['atr_rel'] = tr.rolling(14).mean() / df.close
    df['mom24'] = df.close / df.close.shift(24) - 1
    for idx, od in zip(grp.index, grp.open_date):
        sig = od - pd.Timedelta(hours=1)
        row = df.loc[sig] if sig in df.index else None
        feats.append((idx, *(np.nan,) * 3) if row is None else (idx, row.volume, row.atr_rel, row.mom24))
f = pd.DataFrame(feats, columns=['idx', 'volume', 'atr_rel', 'mom24']).set_index('idx')
base = base.join(f)

learn = base[(base.open_date >= LEARN[0]) & (base.open_date < LEARN[1])]
mv = learn.groupby('pair').volume.median()
ma = learn.groupby('pair').atr_rel.median()
base['B1'] = base.volume / base.pair.map(mv)
base['B2'] = -(base.atr_rel / base.pair.map(ma))
base['B3'] = base.mom24

def line(name, d):
    return f"{name:<28} n={len(d):4d}  Verlustquote={d.loss.mean():6.1%}  Ø Gewinn={d.profit_abs.mean():7.3f} USDT"

def evaluate(label, lo, hi, blind):
    t = base[(base.open_date >= lo) & (base.open_date < hi)].copy()
    t['B4'] = t[['B1', 'B2', 'B3']].rank(pct=True).mean(axis=1)
    c = t[t.stability >= S]
    n = len(c)
    print(f"--- {label} ({'BLIND' if blind else 'nicht blind, nur Info'})")
    print(f"Trades {len(t)}, davon C (Stabilität >= {S}) {n} = {n/len(t):.1%}")
    print(line('A alle', t))
    bs = {}
    for k, name in [('B1', 'B1 Volumen'), ('B2', 'B2 ruhiger Markt'), ('B3', 'B3 Trend 24h'), ('B4', 'B4 Kombination')]:
        b = t.sort_values(k, ascending=False, na_position='last').head(n)
        bs[k] = b
        print(line(name, b))
    print(line('C Delta-Profil', c))
    print(line('  wacklig (aussortiert)', t[t.stability < S]))
    rng = np.random.default_rng(1)
    rand = np.array([t.loss.sample(n, random_state=int(rng.integers(10**9))).mean() for _ in range(10000)])
    print(f"Placebo: Anteil Zufallsauswahlen mit Verlustquote <= C: {(rand <= c.loss.mean()).mean():.3f}")
    best_b_loss = min(b.loss.mean() for b in bs.values())
    gap = best_b_loss - c.loss.mean()
    crit1 = gap >= 0.02
    crit2 = c.profit_abs.mean() > max([t.profit_abs.mean()] + [b.profit_abs.mean() for b in bs.values()])
    print(f"Kriterium 1 (>= 2,0 Pp unter bester B-Regel): Abstand {gap*100:.1f} Pp -> {'erfüllt' if crit1 else 'NICHT erfüllt'}")
    print(f"Kriterium 2 (höchster Ø Gewinn): {'erfüllt' if crit2 else 'NICHT erfüllt'}")
    if blind:
        print("ERGEBNIS:", "ERFOLG nach Vorregistrierung" if crit1 and crit2 else "KEIN belastbarer Zusatznutzen")

evaluate('2024', *Y2024, blind=False)
evaluate('2025', *Y2025, blind=True)
