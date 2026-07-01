# Security Policy

We take the security of KageOps seriously. Thank you for helping keep it and its
users safe.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report privately through **GitHub Private Vulnerability Reporting**:
on this repository go to the **Security** tab → **Report a vulnerability**. This
opens a private advisory that only the maintainers can see, and lets us
collaborate on a fix and coordinate disclosure with you directly.

Please include:

- The affected version / commit and component.
- Steps to reproduce (a minimal PoC helps a lot).
- Impact assessment and any suggested remediation.

## What to expect

- **Acknowledgement** within **3 business days**.
- A **triage + severity assessment** within **10 business days**.
- We'll keep you updated on remediation progress and coordinate a disclosure
  timeline with you. We aim to fix HIGH/CRITICAL issues promptly and will credit
  reporters (with your permission) in the release notes.

> This is a community-driven open-core project. We respond as fast as we
> reasonably can, but there is **no contractual SLA** for the open-source core.
> Commercial KageOps Cloud customers are covered by their agreement.

## Scope

In scope: the code in this repository (the KageOps engine, agent framework,
headless runner, and Command Center desktop UI).

Out of scope: the commercial KageOps Cloud layer (a separate private repo),
third-party AI providers, and issues requiring a compromised host/OS. Secrets you
supply (API keys, tokens) are stored via your OS keychain / env — never commit
them.

## Handling of secrets in this project

- No secrets are committed. CI runs a secret scanner (gitleaks) over the full
  history as a required check, plus a home-grown scanner over tracked files.
- All agent file I/O is repo-scoped (path-traversal prevention).
- SQL is parameterized throughout.
