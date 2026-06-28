![Logo](admin/sunenergyxt500.png)
# ioBroker.sunenergyxt500

[![NPM version](https://img.shields.io/npm/v/iobroker.sunenergyxt500.svg)](https://www.npmjs.com/package/iobroker.sunenergyxt500)
[![Downloads](https://img.shields.io/npm/dm/iobroker.sunenergyxt500.svg)](https://www.npmjs.com/package/iobroker.sunenergyxt500)
![Number of Installations](https://iobroker.live/badges/sunenergyxt500-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/sunenergyxt500-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.sunenergyxt500.png?downloads=true)](https://nodei.co/npm/iobroker.sunenergyxt500/)

**Tests:** ![Test and Release](https://github.com/Creekhail/ioBroker.sunenergyxt500/workflows/Test%20and%20Release/badge.svg)

## sunenergyxt500-Adapter für ioBroker

Integration und Eigenverbrauchsregelung für **SunEnergyXT 500 / 500 PRO** AC-gekoppelte Hybrid-Batteriespeicher über die **lokale HTTP-API** des Geräts — kein Cloud-Konto nötig.

## Sprache / Language

- [English](README.en.md)
- [Deutsch](README.de.md) (Standard)

## Funktionen

* Pollt die lokale API (`GET /read`) und spiegelt alle stabilen Felder in States: SoC, Batterie-/Netz-/Last-/PV-Leistung, Strom/Spannung je MPPT, Tagesenergiezähler, SoC je Pack, Geräte-/Firmware-Infos und Zählerstatus.
* Schreibbare Steuerfelder (`POST /write`, durch Rücklesen bestätigt), passend zur Bedienoberfläche der offiziellen Integration — außer den in der API-Doku als *reserved* markierten Feldern: Netz-Sollwert `GS`, max. Einspeisung `IS`, SoC-Grenzen `SI`/`SA`/`SO`, Eigenverbrauchsmodus `MM`, Zählerkonfiguration `MD`, Zeitzone `TZ`, Neustart `RT`, max. Netzausgang `MG`, die Schalter `LFB`/`LPS`/`PM` sowie lokaler Modus `LM` (⚠️ `LM=1` blockiert die Cloud-/App-Steuerung bis zum Zurücksetzen). Reservierte Felder (z. B. `PT`, `SI1`, `SA1`) sind nur read-only verfügbar.
* Zwei umschaltbare **Steuermodi**: ein adapterseitiger Eigenverbrauchs-**Regler** (schreibt `GS` aus *einem beliebigen* ioBroker-Zähler-State, Feedforward + P, mit Watchdog/Failsafe) oder **Geräte-Eigenregelung** (bindet einen unterstützten Zähler in den Speicher ein und lässt das Gerät selbst regeln) — plus ein **Aus**-Modus für reines Monitoring.
* Verbindungsanzeige (`info.connection`) plus `info.lastUpdate` / `info.lastError`.
* Die komplette, unveränderte `/read`-Antwort liegt in `info.rawResponse` (JSON), sodass jedes Feld, das der Adapter nicht auf einen eigenen State abbildet, dort weiterhin auslesbar ist.

## Wie dieser Adapter funktioniert

Dieser Adapter steuert den Speicher **lokal**, ohne Hersteller-Cloud. Der Eigenverbrauch lässt sich auf **zwei sich gegenseitig ausschließende Arten** umsetzen — du wählst eine über die Einstellung **Steuermodus**:

**Modus B — Adapter-Regler (Standard-Empfehlung, mit jedem Zähler).** ioBroker liest die aktuelle Netzleistung aus **einem beliebigen State**, auf den du ihn zeigen lässt (`gridPowerStateId`), und der Adapter schreibt den Netz-Sollwert `GS` (Feedforward + P-Korrektur, mit Watchdog). Der Zähler kann *alles* sein, was ioBroker unterstützt — Shelly, Tasmota, ein Smartmeter-/Modbus-Adapter — **auch Zähler, die der Speicher selbst nicht lesen kann**. Du lieferst einen State mit der **Netto-Netzleistung in Watt** (`>0` = Bezug, `<0` = Einspeisung; *Vorzeichen invertieren* falls umgekehrt; bei kW / getrennten Bezug-/Einspeisezählern / pro Phase zunächst einen sauberen Nettowert in einem kleinen ioBroker-State berechnen). Der Adapter erzwingt `MM=0`, damit das Gerät `GS` ausführt; der Zähler bleibt voll in ioBroker nutzbar.

**Modus A — Geräte-Eigenregelung (unterstützte Zähler).** Der Adapter bindet einen unterstützten Zähler **in den Speicher** ein (`MM=1` + `MD`) und lässt das **Gerät selbst regeln** — der herstellereigene Eigenverbrauch, der evtl. schneller reagiert als eine externe Schleife. Es werden nur vier Zählertypen unterstützt (EcoTracker, Shelly 3EM, Shelly Pro 3EM, Tasmota), und der Zähler muss für den Speicher im LAN erreichbar sein. In diesem Modus schreibt der Adapter **kein** `GS`. Die Anbindung ist nur mDNS-/HTTP-Polling, der Zähler **bleibt in ioBroker nutzbar** — anders als die Zähler-Einrichtung der Hersteller-App, die den Zähler umkonfigurieren und aus ioBroker entfernen kann; dieser Adapter bindet direkt und vermeidet das.

**Aus (Standard, nur Monitoring).** Der Adapter schreibt nie `MM`/`MD`/`GS`; er pollt nur. `control.*`-States kannst du weiterhin manuell befehlen.

In beiden Steuermodi **besitzt der Adapter `MM`**: bei jedem Poll prüft er das `MM` des Geräts gegen den gewählten Modus und setzt es (mit Warnung) wieder, falls etwas anderes es geändert hat — so kann eine versehentliche Zählerbindung oder ein externes Skript die Steuerung nicht stillschweigend lahmlegen. Hinweis: Das Gerät führt ein geschriebenes `GS` nur bei `MM=0` aus; mit gebundenem Zähler (`MM=1`) regelt es selbst und ignoriert `GS`.

**Lokaler Modus (`LM=1`) ist Voraussetzung.** Das Gerät stellt seine lokale HTTP-API (`/read` / `/write`) nur bereit, wenn der **lokale Modus aktiviert** ist — ohne ihn liefert `/read` keine Daten (auf der getesteten Firmware bestätigt). Der lokale Modus schaltet außerdem die Cloud-/App-Fernsteuerung ab; folglich kann die Hersteller-App das Gerät nicht mehr steuern.

## Voraussetzungen

* Ein SunEnergyXT 500 (`PK=1`, 800 W) oder 500 PRO (`PK=2`, 2400 W), erreichbar im lokalen Netzwerk.
* **Lokaler Modus (`LM=1`) am Gerät aktiviert** — Voraussetzung, damit die lokale HTTP-API Werte liefert (siehe *Wie dieser Adapter funktioniert*). Deaktiviert zugleich die Cloud-/App-Fernsteuerung.
* Ein Zähler, je nach Steuermodus: für **Modus B** (Adapter-Regler) ein beliebiger Zähler, dessen Netzleistung als **ioBroker-State** verfügbar ist; für **Modus A** (Geräte-Eigenregelung) einer der vier unterstützten Zähler (EcoTracker, Shelly 3EM, Shelly Pro 3EM, Tasmota), für den Speicher im LAN erreichbar. Im *Aus*-Modus nicht nötig.

## Installation

1. Im ioBroker-Admin **Adapter** öffnen, nach **sunenergyxt500** suchen und installieren.
2. Nach der Installation entsteht eine Instanz `sunenergyxt500.0`. Deren Einstellungen öffnen und die **Geräte-IP / Hostname** eintragen. Für reines Monitoring den **Steuermodus** auf *Aus* lassen.
3. Speichern & schließen — der Adapter beginnt zu pollen und füllt den Objektbaum unter `sunenergyxt500.0.*`.

## Konfiguration

**Verbindung**
* **Geräte-IP / Hostname** — lokale Adresse des Speichersystems.
* **Abfrageintervall (s)** — wie oft `/read` abgefragt wird (Standard 5 s).
* **Anfrage-Timeout (ms)** — HTTP-Timeout (Standard 8000 ms).

**Steuerung** — einen **Steuermodus** wählen:

*Aus* (Standard) — nur Monitoring; der Adapter schreibt nie `MM`/`MD`/`GS`.

*Adapter-Regler* (Modus B) — Felder:
* **Quell-State Netzleistung** — ein Fremd-State mit der Netzleistung deines Hauszählers. Konvention: `>0` = Netzbezug, `<0` = Einspeisung. **Vorzeichen invertieren** aktivieren, falls dein Zähler die umgekehrte Konvention nutzt.
* **Verstärkung** (Standard 0.3), **Totband** (W), **Min. Schreibintervall** (ms), **Max. Leistung** (W, 2400 fürs Pro / 800 fürs Standard).
* **Watchdog Warnung / Failsafe (s)** — wird die Netzquelle zu alt, loggt der Regler eine Warnung und erzwingt schließlich `GS=0` (sicherer Neutralzustand), bis die Quelle zurück ist. Watchdog-Telemetrie liegt unter `controller.*`.

Der Regler liest vor jeder Korrektur die tatsächliche Netzleistung (`GP`) des Geräts zurück — das ergibt natürlichen Anti-Windup, wenn das Gerät intern begrenzt (z. B. durch SoC).

*Geräte-Eigenregelung* (Modus A) — Felder:
* **Zählertyp** — EcoTracker / Shelly 3EM / Shelly Pro 3EM / Tasmota.
* **Zähler-SN / IP** — die Seriennummer für Shelly/Tasmota (per mDNS aufgelöst) bzw. die LAN-IP für EcoTracker (direkt). Bei Tasmota die SN ohne die letzten 4 Zeichen und den **Power-Key** passend zu deinem Energiezähler-Subtyp setzen.

Der Adapter bindet den Zähler (`MM=1` + `MD`) und das Gerät regelt selbst; der Adapter schreibt kein `GS`. Der gebundene Zähler bleibt in ioBroker nutzbar.

> **Sicherheit:** Im *Aus*-Modus ist der Adapter read-only — er pollt nur `/read` und schreibt nichts, außer du befiehlst einen `control.*`-State. In einem Steuermodus **erzwingt** der Adapter das passende `MM` und setzt es bei externer Änderung wieder; lass **nicht** gleichzeitig einen zweiten `GS`-Schreiber laufen (dein eigenes Skript oder den geräteeigenen `MM`-Modus mit einem anderen Zähler), sonst kämpfen sie um den Akku.

## Vorzeichenkonventionen

* `GP` (Netzleistung): `>0` = Einspeisung, `<0` = Bezug — **entgegengesetzt zu einem Shelly-Zähler** (`api.GP ≈ −shelly.gridPower`).
* `PB` (Batterieleistung): `>0` = Laden, `<0` = Entladen.
* `GS` (Netz-Sollwert): `>0` = Einspeisung/Entladen, `<0` = Netzladen (±2400 W beim Pro, 10-W-Schritte).

## Objektbaum

Die States sind in thematische Kanäle gruppiert. Das **Blatt jeder Objekt-ID ist der API-Feldcode** des Geräts (die Entitäts-ID der offiziellen Feldreferenz), und der zweisprachige Objektname beschreibt es — so bildet der Baum die dokumentierten Gerätefelder 1:1 ab.

| Kanal | Inhalt |
|---|---|
| `battery.*` | SoC (`SC`), Batterieleistung (`BP`), SoC je Pack (`SC0`–`SC5`), Packs online (`ON`), SoC-Hysterese (`SI1`/`SA1`) |
| `grid.*` | Netzleistung (`GP`), Tages-Lade-/Einspeiseenergie (`GD1`/`GD2`) |
| `load.*` | Lastleistung (`LP`), Tages-Inselbetriebs-Lastenergie (`LD`) |
| `pv.*` | PV gesamt (`PV`) und Leistung/Strom/Spannung je MPPT (`mppt1`–`mppt4`) |
| `system.*` | Gesamt-Ein-/Ausgangsleistung (`IW`/`OP`) |
| `device.*` | Typ/Modell/Seriennummer/Status; `device.network.*` (IP, Port, WLAN); `device.firmware.*` (`ES`/`AS`/`DS` Software, `EH`/`AH`/`DH` Hardware, `BS0`–`BS5` BMS) |
| `meter.*` | Status des externen Zählers (`MS`) |
| `ups.*` | USV-Modus / Netzladen / Bypass (`UO`/`UG`/`FP`) |
| `fault.*` | Fehler-Bitmasks (`TF`/`EF`/`DF1`/`DF2`/`AF1`/`AF2`/`BF`) — nur im aktiven Fehlerfall befüllt |
| `control.*` | alle **schreibbaren** Felder (siehe unten) |
| `controller.*` | Telemetrie des Eigenverbrauchsreglers |
| `info.*` | `connection`, `lastUpdate`, `lastError`, `rawResponse` (komplette `/read`-Rohantwort), Geräte-`timestamp` |

### Schreibbare Steuerfelder (`control.*`)

Per ioBroker-Konvention liegen alle schreibbaren Felder unter `control.*`. Da das die thematische Zuordnung verflacht, zeigt diese Tabelle, wozu jedes Feld gehört:

| Objekt | Feld | Gehört zu | Beschreibung |
|---|---|---|---|
| `control.GS` | GS | grid | Netzleistungs-Sollwert (`>0` Einspeisung / `<0` Netzladen) |
| `control.IS` | IS | grid | Max. Netzeinspeisung / WR-Ausgangsgrenze |
| `control.MG` | MG | grid | Max. netzgekoppelte Ausgangsleistung |
| `control.SI` | SI | battery | Min. Entlade-SoC (Netzbetrieb) |
| `control.SA` | SA | battery | Max. Lade-SoC (Netzbetrieb) |
| `control.SO` | SO | battery | Min. Entlade-SoC (Inselbetrieb) |
| `control.MM` | MM | mode | Lokale Nulleinspeisung / Eigenverbrauch (gekoppelt mit `MD`) |
| `control.MD` | MD | meter | Zählerverbindung als JSON (gekoppelt mit `MM`) |
| `control.LM` | LM | mode | Lokaler Modus (⚠️ `1` blockiert Cloud-/App-Steuerung) |
| `control.LFB` | LFB | mode | Lastprioritäts-Schalter |
| `control.LPS` | LPS | mode | Inselausgang-Schalter |
| `control.PM` | PM | mode | Parallel-Modus |
| `control.TZ` | TZ | device | POSIX-Zeitzone |
| `control.RT` | RT | device | Gerät neu starten (Button) |

> Tipp: Im ioBroker-Admin kannst du die Objektliste auch nach dem *beschreibbar*-Flag filtern, um alle Steuerfelder auf einmal zu finden.

`device.PK` wird aus `DevType` abgeleitet, wenn die Firmware `PK` nicht mehr liefert. Reservierte Felder (`PT`, `SI1`, `SA1`) sind read-only. Vom Hersteller entfernte (`PD`, `UP`) oder reine Doku-Artefakte (`WT`, `BN`) werden nicht angelegt; alles Ungemappte steht weiterhin in `info.rawResponse`.

## Manuelle Zähler-/Modus-Felder (MM / MD)

`MM`/`MD` sind die geräteeigene zählerbasierte Eigenverbrauchsregelung. Wenn du einen **Steuermodus** wählst, verwaltet der Adapter sie für dich (Modus A setzt `MM=1` + `MD`; Modus B erzwingt `MM=0`), und sein Guard setzt das modusgerechte `MM` beim nächsten Poll wieder — eine manuelle Änderung in einem Steuermodus ist also nur vorübergehend.

Die Roh-Felder bleiben für Experten-/Handbetrieb schreibbar (z. B. im *Aus*-Modus). Sie folgen der offiziellen Kopplung: `MM` ausschalten löscht auch `MD`, und das Schreiben von `MD` aktiviert `MM` (nicht-leer) bzw. deaktiviert es (leer). Die `MD`-JSON-Formate der vier unterstützten Zähler stehen in der lokalen API-Referenz des Geräts; im Modus *Geräte-Eigenregelung* baut der Adapter sie aus Zählertyp und SN/IP für dich.

## Einschränkungen

* **Nur Einzelkopf.** Jede Adapter-Instanz überwacht und steuert genau einen SunEnergyXT-Kopf (über dessen eigene IP); eine koordinierte Steuerung mehrerer Köpfe wird nicht unterstützt.
* Tagesenergiezähler (`GD1`/`GD2`/`LD`) sind rohe **Wh**, nicht kWh.
* `MD` und `TZ` wirken sofort, werden vom Gerät aber nicht garantiert wortgleich zurückgemeldet — über die Wirkung bestätigen, nicht über das Echo.
* **PV-Eingänge sind ungetestet mit Hardware** (die Referenzanlage läuft ohne PV-Module, daher sind `PV1–4` immer 0). Integration und Regler sind PV-agnostisch und vollständig, aber PV-Firmware-Edge-Cases (z. B. Akku voll + PV-Überschuss, USV-/Bypass-Felder `FP`/`UG`) sind unverifiziert — Feedback willkommen.

## Fehlerbehebung

* **`info.connection` bleibt `false` / keine Daten:** stelle zuerst sicher, dass der **lokale Modus (`LM=1`)** am Gerät aktiviert ist — ohne ihn liefert die lokale API keine Werte. Prüfe dann, ob `http://<geräte-ip>/read` vom ioBroker-Host erreichbar ist (mit Browser oder `curl` testen).
* **Es wird nichts gesteuert:** prüfe den **Steuermodus** — *Aus* schreibt nie. Im *Adapter-Regler* einen gültigen **Quell-State Netzleistung** setzen; in *Geräte-Eigenregelung* einen unterstützten **Zählertyp** und **SN/IP**.
* **Gerät ignoriert `GS` / Akku reagiert nicht:** das Gerät führt ein geschriebenes `GS` nur bei `MM=0` aus. Im *Adapter-Regler*-Modus erzwingt der Adapter das; wenn du `GS` manuell schreibst, stelle sicher, dass kein Zähler gebunden ist (`MM=0`). Mit gebundenem Zähler (`MM=1`) regelt das Gerät selbst und ignoriert `GS`.
* **Zwei Regler kämpfen um den Akku:** nur einen laufen lassen. Der Adapter erzwingt `MM` für den gewählten Modus — deaktiviere ein externes `GS`-Skript (oder den geräteeigenen `MM` mit anderem Zähler), bevor du einen Steuermodus nutzt.
* **Manche States bleiben leer (`0` / `""`):** das Gerät liefert nur die Felder, die seine Firmware/Topologie tatsächlich bereitstellt (z. B. weitere Packs `SC2`–`SC5` oder Fehler-Bitmasks nur im Fehlerfall). Die komplette Rohantwort steht immer in `info.rawResponse`.

## Änderungshistorie (Changelog)

Die Änderungshistorie wird im Haupt-[README.md](README.md#changelog) gepflegt.

## Lizenz
MIT-Lizenz

Copyright (c) 2026 Marcus Bortel (Creekhail)

Die Erlaubnis wird hiermit unentgeltlich jeder Person erteilt, die eine Kopie dieser Software und der zugehörigen Dokumentationsdateien (die „Software") erhält, mit der Software uneingeschränkt zu handeln, einschließlich und ohne Einschränkung der Rechte, sie zu nutzen, zu kopieren, zu ändern, zusammenzuführen, zu veröffentlichen, zu verbreiten, zu unterlizenzieren und/oder zu verkaufen, und Personen, denen die Software überlassen wird, dies zu gestatten, unter den folgenden Bedingungen:

Der obige Urheberrechtshinweis und dieser Erlaubnishinweis sind in allen Kopien oder wesentlichen Teilen der Software beizufügen.

DIE SOFTWARE WIRD „WIE BESEHEN" BEREITGESTELLT, OHNE JEGLICHE AUSDRÜCKLICHE ODER STILLSCHWEIGENDE GEWÄHRLEISTUNG, EINSCHLIESSLICH, ABER NICHT BESCHRÄNKT AUF DIE GEWÄHRLEISTUNG DER MARKTGÄNGIGKEIT, DER EIGNUNG FÜR EINEN BESTIMMTEN ZWECK UND DER NICHTVERLETZUNG VON RECHTEN. IN KEINEM FALL HAFTEN DIE AUTOREN ODER URHEBERRECHTSINHABER FÜR ANSPRÜCHE, SCHÄDEN ODER SONSTIGE HAFTUNG, OB AUS VERTRAG, UNERLAUBTER HANDLUNG ODER ANDERWEITIG, DIE SICH AUS DER SOFTWARE ODER DER NUTZUNG ODER SONSTIGEN VERWENDUNG DER SOFTWARE ERGEBEN.
