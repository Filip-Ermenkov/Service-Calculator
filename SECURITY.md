# Security policy

This repository is the source of `https://bulbau.lu`. Only the current `main`
branch, which is what production runs, is supported.

## Reporting a vulnerability

Please report it privately through
[GitHub's private vulnerability reporting](https://github.com/Filip-Ermenkov/Service-Calculator/security/advisories/new).
Do not open a public issue. If you cannot use GitHub, write to
`office@bulbau.lu` and ask for the developer.

Include what you found, where (URL or file), and how to reproduce it. You will
get an acknowledgement within 5 working days and a status update at least every
two weeks until it is resolved.

## Scope

In scope: the public site, the admin panel at `/admin`, the `/api/*`
endpoints, and the infrastructure code in this repository.

Out of scope: denial-of-service and volumetric testing, social engineering, and
the third-party services the site uses (AWS, Neon, Cloudflare, Google), which
have their own programmes.

Please test only against your own data, and never access or change another
person's.

The machine-readable version of this contact is
`https://bulbau.lu/.well-known/security.txt` (RFC 9116).
