# Vorregistrierung: Delta-Prüfprofil als Fehlerfilter

Festgelegt am 14.10.2026, VOR dem ersten Lauf. Nachträglich wird nichts geändert.

## Vorhersager (eingefroren)
Supertrend aus freqtrade-strategies, Commit 8fddeae (startup_candle_count 199).
Jeder Trade = eine Vorhersage "dieser Trade endet im Gewinn".

## Daten
Binance US, 1h, Paare BTC, ETH, LTC, BNB, ADA, SOL gegen USDT.
Lernzeitraum: 2022-01-01 bis 2023-12-31. Testzeitraum (blind): 2024-01-01 bis 2024-12-31.
Freqtrade 2025.2, Standardgebühren der Börse, max_open_trades unbegrenzt, 100 USDT pro Trade.

## Delta-Prüfprofil (7 Varianten)
1. Vorlauf 100 statt 199 Kerzen
2.-7. Je ein Kaufparameter um 1 verändert: buy_m1 +1/-1, buy_p1 +1/-1, buy_p2 +1/-1
Stabilität eines Trades = Anteil der 7 Varianten, die denselben Einstieg (Paar + Einstiegszeit) ebenfalls haben.

## Vergleichsregeln
- A: alle Trades
- B: einfache Regel "Volumen der Einstiegskerze über dem Median des Lernzeitraums (je Paar)"
- C: Delta-Profil "Stabilität mindestens Schwelle S"; S wird nur auf dem Lernzeitraum so gewählt, dass etwa die Hälfte der Trades bleibt.
Im Test wählen B und C jeweils GLEICH VIELE Trades (B nach Volumen-Rang, C nach Stabilität, Gleichstand nach Volumen-Rang).

## Messung im Test
Verlustquote und durchschnittlicher Gewinn pro Trade, nach Gebühren.
Placebo: 10.000 zufällige Auswahlen gleicher Größe -> Anteil, der so gut ist wie C.

## Erfolg / Abbruch
Erfolg nur, wenn C im Test eine niedrigere Verlustquote hat als B UND als A UND im Placebo besser ist als 95 % der Zufallsauswahlen.
Sonst: kein Zusatznutzen nachgewiesen, kein Mastertool.
