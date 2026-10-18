# Incident 2026-10-18: VPS powered off (and the legacy `nats` / `caddy` services removed)

_Written 2026-10-19. All changes below were made on the VPS by the owner. Raw diagnostics: `C:\vyxtrader\diag-nats-poweroff-20261019-0004.txt` on the VPS._

## What happened

* **2026-10-18 17:05:49 UTC** the Contabo VPS (`feed.vyxtrader.com`, 161.97.138.160) shut down.
* System log event 1074: `winlogon.exe` on behalf of `NT AUTHORITY\SYSTEM`, reason code **0x500ff** (System / Other, unplanned), kernel reason "Kernel API".
  This is the pattern of an ACPI power-off request from outside Windows (power button, i.e. a hypervisor or panel Stop/Restart).
* **Not Windows Update:** no update-driven restart in the log, no reboot pending, `AUOptions=3` (download and notify, never auto-install).
  An update restart is logged by TrustedInstaller / the update orchestrator with a planned reason (for example 0x80020010).
* **Cause: Contabo panel or host side.** The owner is opening a Contabo ticket to get the node's maintenance/activity record for that time.
  Update this note with the answer.

## What the diagnostics found on the way

* `vyxtrader-engine` and `vyxtrader-gateway` had a Windows service dependency on the **legacy `nats`** service, but both were
  connected to **`vyxtrader-nats`** (127.0.0.1:4222, pid 4308). The dependency was wrong: it did not guarantee that the NATS the
  services actually use was started first.
* The legacy `nats` was also running and listening on **0.0.0.0:4222** with no clients: an unused NATS exposed on all interfaces.
* The legacy `caddy` service was still registered (already disabled); `vyxtrader-caddy` is the real one.

## Changes made (owner, VPS, 2026-10-19)

1. `sc config vyxtrader-engine depend= vyxtrader-nats` and the same for `vyxtrader-gateway`; verified with `sc qc`.
2. Legacy `nats` stopped and removed. Legacy `caddy` removed. (Service entries only; files untouched.)
3. Windows Firewall rule blocking inbound TCP 4222.

**Verified after:** all four `vyxtrader-*` services (`engine`, `gateway`, `nats`, `caddy`) RUNNING; port 4222 bound only on
127.0.0.1 by pid 4308 (`vyxtrader-nats`); engine and gateway connected to it; engine heartbeat 0.1 s.

## Follow-ups

* Contabo ticket: the reason for the 17:05:49 UTC power-off (open, owner).
* After any VPS reboot, run the check in `docs/STAGE6-RUNBOOK-FUTURIX-DEMO.md`, section 11.
