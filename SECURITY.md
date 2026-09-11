# Security Policy

## Supported versions

Only the latest released version of `iobroker.sunenergyxt500` receives security fixes.
Please make sure the issue still exists in the current release before reporting it.

## Reporting a vulnerability

**Please do not report security issues through public GitHub issues, discussions or the ioBroker forum.**

Use GitHub's private vulnerability reporting instead:
👉 [Report a vulnerability](https://github.com/Creekhail/ioBroker.sunenergyxt500/security/advisories/new)

Helpful details:

- affected adapter version (and js-controller / Node.js version)
- a description of the issue and its impact
- steps to reproduce or a proof of concept
- a suggested fix, if you have one

This adapter is a community project maintained in my spare time. I will acknowledge your
report as soon as possible, keep you updated on the progress and credit you in the advisory
unless you prefer to stay anonymous.

## Scope

In scope: the code of this adapter, e.g. how it handles its configuration, the data it
reads from the device and the values it writes to it.

Out of scope, please report these to the respective project instead:

- the SunEnergyXT device, its firmware or its local API → manufacturer
- ioBroker core components (js-controller, admin, ...) → [ioBroker](https://github.com/ioBroker)
- known issues in development-only dependencies of the ioBroker tooling
  (`@iobroker/dev-server`, `@iobroker/adapter-dev`, `@iobroker/testing`), which are not
  part of the published adapter

---

## Deutsch – Sicherheitslücken melden

Bitte Sicherheitslücken **nicht** öffentlich über Issues oder das Forum melden, sondern
vertraulich über GitHub:
👉 [Sicherheitslücke melden](https://github.com/Creekhail/ioBroker.sunenergyxt500/security/advisories/new)

Sicherheitsupdates gibt es nur für die jeweils aktuelle Version.
