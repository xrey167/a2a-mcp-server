# Supply Chain Risk Module — Implementierungsplan

## Überblick

Neuer A2A Worker `supply-chain-agent` (Port 8089) der Produktionsaufträge, Verkaufsaufträge und deren Komponenten aus **Business Central** und **Odoo** analysiert, gegen globale Risikofaktoren prüft und Interventionsempfehlungen gibt.

## Architektur

```
┌─────────────────────────────────────────────────────────┐
│  supply-chain-agent (Port 8089)                         │
│                                                         │
│  Skills:                                                │
│  ├── connect_erp          — ERP-Verbindung konfigurieren│
│  ├── analyze_orders       — Aufträge & BOM analysieren  │
│  ├── critical_path        — Kritische Pfade ermitteln   │
│  ├── assess_risk          — Globale Risikobewertung     │
│  ├── recommend_actions    — Interventionen berechnen    │
│  ├── monitor_dashboard    — Übersichtsdaten             │
│  └── remember / recall                                  │
│                                                         │
│  ERP Connectors:                                        │
│  ├── src/erp/business-central.ts  (OData v4 API)        │
│  └── src/erp/odoo.ts              (JSON-RPC API)        │
│                                                         │
│  Risk Data Sources:                                     │
│  └── src/risk/sources.ts                                │
│      ├── Freight/Shipping (via web-agent fetch_url)     │
│      ├── Weather events   (via web-agent fetch_url)     │
│      ├── Economic data    (via web-agent fetch_url)     │
│      └── Commodity prices (via web-agent fetch_url)     │
│                                                         │
│  Analysis Engine:                                       │
│  ├── src/risk/critical-path.ts    — CPM-Algorithmus     │
│  ├── src/risk/lead-time.ts        — Durchlaufanalyse    │
│  ├── src/risk/scoring.ts          — Risiko-Scoring      │
│  └── src/risk/interventions.ts    — Make-or-Buy etc.    │
└─────────────────────────────────────────────────────────┘
```

## Dateien die erstellt/geändert werden

### Neue Dateien

1. **`src/workers/supply-chain.ts`** (Port 8089)
   - Fastify-Server nach bestehendem Worker-Muster (wie data.ts)
   - Agent Card mit 6 Skills + remember/recall
   - Zod-Schemas für alle Skill-Parameter
   - Skill-Dispatcher

2. **`src/erp/business-central.ts`**
   - OData v4 Client für Business Central
   - Endpunkte: Production Orders, Sales Orders, BOM (Bill of Materials), Item Ledger, Vendor, Purchase Orders
   - Auth: OAuth2 Client Credentials oder API Key (konfigurierbar)
   - Datenmodelle: `ProductionOrder`, `SalesOrder`, `BOMComponent`, `Vendor`, `PurchaseOrder`

3. **`src/erp/odoo.ts`**
   - JSON-RPC Client für Odoo
   - Models: `mrp.production`, `sale.order`, `mrp.bom`, `product.product`, `purchase.order`, `res.partner`
   - Auth: Database + Username + API Key
   - Gleiche Datenmodelle wie BC-Connector (normalisiertes Interface)

4. **`src/erp/types.ts`**
   - Gemeinsame, ERP-agnostische Interfaces:
     ```ts
     interface ProductionOrder { id: string; number: string; itemNo: string; itemName: string;
       quantity: number; dueDate: string; status: string; components: BOMComponent[]; routings: RoutingStep[]; }
     interface SalesOrder { id: string; number: string; customerName: string;
       lines: SalesLine[]; requestedDeliveryDate: string; }
     interface BOMComponent { itemNo: string; itemName: string; quantityPer: number;
       replenishmentMethod: "purchase" | "production" | "assembly" | "transfer";
       vendorNo?: string; vendorName?: string; leadTimeDays: number; unitCost: number;
       safetyStock: number; inventoryLevel: number; }
     interface SupplyChainGraph { nodes: GraphNode[]; edges: GraphEdge[]; criticalPath: string[]; }
     ```

5. **`src/risk/critical-path.ts`**
   - Critical Path Method (CPM) Implementierung
   - Input: BOM-Baum mit Durchlaufzeiten pro Komponente
   - Output: Kritischer Pfad, Pufferzeiten, Gesamtdurchlaufzeit
   - Erkennung von Langlaufteilen (lead time > Schwellwert)

6. **`src/risk/lead-time.ts`**
   - Durchlaufzeit-Analyse für Komponenten
   - Historische Lieferzeiten vs. geplante Lieferzeiten
   - Erkennung von Trends (steigende/fallende Lieferzeiten)
   - Lieferanten-Zuverlässigkeits-Score

7. **`src/risk/scoring.ts`**
   - Multi-dimensionales Risiko-Scoring:
     - **Verfügbarkeitsrisiko**: Lagerbestand vs. Bedarf, Sicherheitsbestand-Deckung
     - **Lieferrisiko**: Lieferantenabhängigkeit, Single-Source, geografische Konzentration
     - **Preisrisiko**: Volatilität, Rohstoffpreistrends
     - **Durchlaufzeitrisiko**: Lead-Time-Variabilität, Pufferzeit-Restmenge
     - **Externes Risiko**: Wetter, Fracht, geopolitisch, ökonomisch
   - Gewichteter Gesamtscore pro Komponente (0-100, 100 = höchstes Risiko)

8. **`src/risk/interventions.ts`**
   - Interventionsempfehlungen basierend auf Risikoprofil:
     - **Make-or-Buy-Analyse**: Eigenfertigungs-Kalkulation vs. Fremd-Beschaffung
     - **Sicherheitsbestand-Anpassung**: Optimaler Mindestbestand basierend auf Risiko
     - **Alternative Lieferanten**: Vorschläge für Dual/Multi-Sourcing
     - **Vorab-Beschaffung**: Frühzeitige Bestellung bei steigenden Risiken
     - **Produktionsplan-Anpassung**: Umplanung bei kritischen Engpässen
   - Kosten-Nutzen-Berechnung pro Intervention

9. **`src/risk/sources.ts`**
   - Externe Risikodaten-Aggregation (via web-agent/ai-agent)
   - Kategorien:
     - Fracht/Schifffahrt: Containerpreise, Hafenverzögerungen, Routenstörungen
     - Wetter: Extremwetter-Events in Lieferantenregionen
     - Ökonomie: Wechselkurse, Inflation, Rohstoffindizes
     - Geopolitisch: Sanktionen, Handelsbarrieren, regionale Instabilität
   - Caching mit TTL (Wetterdaten: 6h, Ökonomie: 24h, Geopolitik: 12h)
   - Nutzt ai-agent (`ask_claude`) für Bewertung/Interpretation

10. **`src/personas/supply-chain.md`**
    - Persona-Definition für den Supply-Chain-Agenten

### Geänderte Dateien

11. **`src/server.ts`**
    - Neuer Eintrag in `ALL_WORKERS`:
      ```ts
      { name: "supply-chain", path: join(__dirname, "workers/supply-chain.ts"), port: 8089 }
      ```

## Skills im Detail

### `connect_erp`
- Konfiguriert ERP-Verbindung (BC oder Odoo)
- Parameter: `{ system: "bc" | "odoo", url: string, credentials: {...}, company?: string }`
- Speichert Verbindungsdaten verschlüsselt in `~/.a2a-mcp/supply-chain.json`
- Testet Verbindung und gibt Status zurück

### `analyze_orders`
- Lädt und analysiert Produktions- und Verkaufsaufträge
- Parameter: `{ orderType?: "production" | "sales" | "both", status?: string, dateFrom?: string, dateTo?: string, itemFilter?: string }`
- Extrahiert BOM-Struktur, Beschaffungsmethoden, Lieferanten
- Gibt strukturierte Analyse zurück mit Komponentenübersicht

### `critical_path`
- Ermittelt kritische Pfade in der Fertigungs-/Beschaffungskette
- Parameter: `{ productionOrderId?: string, itemNo?: string, depth?: number }`
- CPM-Algorithmus über BOM-Baum
- Identifiziert Langlaufteile und Engpässe
- Gibt Gantt-ähnliche Datenstruktur zurück

### `assess_risk`
- Bewertet Risiken gegen externe Faktoren
- Parameter: `{ scope?: "all" | "critical_only", includeExternal?: boolean, riskCategories?: string[] }`
- Aggregiert interne Daten (Lagerbestand, Lieferzeiten) mit externen Quellen
- Nutzt ai-agent für Interpretation von Nachrichtenquellen
- Gibt Risiko-Matrix zurück (Komponente × Risikodimension)

### `recommend_actions`
- Berechnet und priorisiert Interventionsmaßnahmen
- Parameter: `{ riskThreshold?: number, maxRecommendations?: number, includeCosting?: boolean, strategies?: ("make_or_buy" | "safety_stock" | "dual_source" | "advance_purchase" | "reschedule")[] }`
- Kosten-Nutzen-Analyse pro Empfehlung
- Priorisierung nach Impact und Dringlichkeit

### `monitor_dashboard`
- Aggregierte Übersichtsdaten für Supply-Chain-Status
- Parameter: `{ period?: string }`
- KPIs: Risikolevel gesamt, kritische Komponenten, offene Interventionen
- Trend-Daten für zeitliche Entwicklung

## Implementierungsreihenfolge

1. **Schritt 1**: ERP-Typen und Interfaces (`src/erp/types.ts`)
2. **Schritt 2**: Business Central Connector (`src/erp/business-central.ts`)
3. **Schritt 3**: Odoo Connector (`src/erp/odoo.ts`)
4. **Schritt 4**: Risk-Engine Module (`src/risk/*.ts`)
5. **Schritt 5**: Worker mit allen Skills (`src/workers/supply-chain.ts`)
6. **Schritt 6**: Persona (`src/personas/supply-chain.md`)
7. **Schritt 7**: Server-Registrierung (`src/server.ts` — ALL_WORKERS)
8. **Schritt 8**: Commit & Push

## Technische Details

- **Port**: 8089
- **Dependencies**: Keine neuen — nutzt bestehende Fastify, Zod, und A2A-Infrastruktur
- **Externe Daten**: Via web-agent (fetch_url) und ai-agent (ask_claude) — keine direkten HTTP-Calls
- **Logging**: Ausschließlich über `process.stderr.write()` (MCP-Konformität)
- **Imports**: ESM mit `.js`-Extensions
