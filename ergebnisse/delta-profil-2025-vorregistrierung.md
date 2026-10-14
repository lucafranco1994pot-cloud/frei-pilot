# Vorregistrierung Blindtest 2: Delta-Profil auf 2025

Festgelegt am 14.10.2026, VOR dem Lauf. Ergebnis 2024 ist bekannt (siehe delta-profil.txt).

## Unverändert gegenüber Test 1
Vorhersager, Paare, Börse, Freqtrade-Version, Einstellungen und die 7 Delta-Varianten sind identisch.
Keine Nachbesserung am Delta-Profil.
Schwelle S wird fest auf 1.0 gesetzt (der Wert aus Test 1; dort blieben 61 % statt geplant ~50 %, dokumentierte Abweichung).
Lernzeitraum für Mediane: 2022-01-01 bis 2023-12-31 (unverändert).

## Testzeitraum (blind)
2025-01-01 bis 2025-12-31.

## Vergleichsregeln (neu, stärker)
Alle nutzen nur Daten bis zur Signalkerze (Kerze vor dem Einstieg).
- A: alle Trades
- B1 Volumen: Volumen / Lern-Median des Paares, höher = besser
- B2 ruhiger Markt: ATR(14)/Schlusskurs, geteilt durch Lern-Median des Paares, niedriger = besser
- B3 Trend 24 h: Schlusskurs / Schlusskurs vor 24 Kerzen - 1, höher = besser
- B4 Kombination: Mittelwert der Rangplätze von B1, B2, B3
- C Delta-Profil: Stabilität >= 1.0
Jede B-Regel wählt im Test GLEICH VIELE Trades wie C (die besten nach ihrem Wert).

## Erfolgskriterium
ERFOLG nur, wenn beides gilt:
1. Verlustquote von C ist mindestens 2,0 Prozentpunkte niedriger als die niedrigste Verlustquote von B1-B4.
2. Ø Gewinn pro Trade von C ist höher als bei A und bei jeder B-Regel.
Sonst: KEIN belastbarer Zusatznutzen.

## Zusatzinfo (kein Erfolgskriterium)
Dieselben Regeln werden auch für 2024 berichtet (nicht blind, nur zum Vergleich).
Placebo: 10.000 Zufallsauswahlen gleicher Größe (Trades nicht unabhängig, Wert ist optimistisch).
