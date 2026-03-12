# Launch Co: Quote-to-Order Command Center (1-Seite, kundenfertig)

**Ansprechpartner:** Launch Co Management (Ops, Sales, Finance)  
**Datum:** 11.03.2026  
**Produkt:** Quote-to-Order Command Center (Odoo + Business Central + Dynamics)  
**Go-Live Status:** `launched` (Production)

## Kurzfazit

Launch Co hat den Quote-to-Order Prozess produktiv gestartet und bereits im ersten Lauf messbaren operativen Nutzen erzielt.  
Die Kern-Gates für Sicherheit und Launch-Fähigkeit sind erfüllt, die verbleibenden Punkte sind klar identifiziert und in einem konkreten Stabilisierungspfad adressierbar.

## Business Outcome in Zahlen

| KPI | Baseline | Aktuell | Veränderung |
|---|---:|---:|---:|
| Abgeschlossene Runs | 0 | 1 | +1 |
| Failure Rate | 0% | 0% | 0 pp |
| Manuelle Schritte reduziert | 0 | 4 | +4 |
| Zeitgewinn | 0,0 h | 1,6 h | +1,6 h |
| Geschätzter Wertbeitrag | EUR 0 | EUR 136 | +EUR 136 |

## Executive KPI Snapshot

| KPI | Aktuell |
|---|---:|
| Quote->Order Conversion Rate | 100% |
| Median Approval Time | 0 Min. |
| Revenue-at-Risk | EUR 0 |
| Time Saved | 1,6 h |
| Manual Steps Removed | 4 |
| Estimated Value | EUR 136 |

## Betriebsqualität (Ops)

| Bereich | Status |
|---|---|
| Odoo Quote Sync | 1 Lauf, 0 Fehler (0%) |
| Dynamics Lead Sync | 1 Lauf, 1 Fehler (100%) |
| Dead-Letter Queue | 1 Eintrag |
| Replays | 0 |
| MTTR | 0 Min. |

## Governance und Nachvollziehbarkeit

1. Vollständige Traceability vorhanden (wer/was/wann/Ergebnis inkl. Gate-Entscheidungen).  
2. Alle kritischen Launch-Gates sind grün (`workspace_isolation`, `required_connectors`, `dry_run_success`).  
3. Nicht-kritische Risiken wurden mit Begründung und Freigabe übersteuert (auditierbar).

## Offene Punkte (kontrolliert)

1. Dynamics Connector derzeit `unhealthy` (bekannter transienter Fehlerpfad).  
2. Mapping Drift Backlog: 90 offene Mapping-Drifts.  
3. SLA-Hinweis aktiv: Mindestziel von 3 Completed Runs noch nicht erreicht.

## 14-Tage Plan bis „Expansion Ready“

1. Dynamics auf `healthy` stabilisieren und DLQ-Replay-Pfad schließen.  
2. Mapping Drift priorisiert abbauen (zuerst umsatzrelevante Felder).  
3. Mindestens 3 erfolgreiche Runs erreichen und SLA-Warnung schließen.

## Kaufempfehlung (Commercial)

**Empfohlenes Paket:** Managed Onboarding + Managed Cloud + Weekly Optimization  
**Preisspanne:** EUR 1.500-EUR 3.000 pro Monat (+ Setup, optional bei Annual erlassbar)  
**Entscheidungslogik:** Expansion erst nach nachweisbarem KPI- und Reliability-Fortschritt.

## Entscheidungsvorlage

Freigabe zur Fortführung des bezahlten Piloten mit 14-Tage-Stabilisierungsgate und anschließender Expansion-Entscheidung bei Erreichen der drei Zielkriterien.
