# Security policy

## Deployment boundary

batchcraft is a single-user, local-first application. It has no user authentication
or authorization. Keep the backend bound to loopback and use ComfyUI only on a
trusted LAN. Do not expose either service to the public Internet, forward their
ports, or treat browser origin checks as authentication. Restrict ComfyUI access
with the host firewall to the machines that need it.

Anyone who can reach the API may be able to read Project data, change application
state, or submit GPU work. Run the application with an unprivileged OS account and
trust the workflows, custom nodes, and ComfyUI installation you use. Local-first
does not mean encrypted: SQLite, Project files, logs, and browser recovery state
may contain private prompts, paths, Reference Assets, and Results.

Treat `manifest.csv` as raw data. Prompts and names can begin with spreadsheet formula characters;
CSV quoting does not neutralize formulas. Use a text editor or import all columns explicitly as text,
with formula evaluation disabled. Do not double-click an untrusted manifest into a spreadsheet.
Historical manifests are not silently modified to make spreadsheet cells safe.

## Reporting a vulnerability

Report vulnerabilities privately through this repository's
[GitHub security advisories](https://github.com/pixeldj/batchcraft/security/advisories).
Use **Report a vulnerability** when available. Private vulnerability reporting
must be enabled and verified by a maintainer before public publication. If that
option is unavailable, do not post exploit details or private data in an issue;
ask a maintainer to enable private reporting without disclosing the vulnerability.

Include the affected commit or version, impact, and minimal reproduction steps
with synthetic data. Do not attach real credentials, personal images, full Project
directories, or unredacted logs. No response-time or older-release support
guarantee is currently offered.

## Source distribution and privacy

batchcraft source is licensed under GNU GPL version 3 only (`GPL-3.0-only`), not
"version 3 or later". The complete, unmodified license is in [LICENSE](LICENSE).
Its example application notice does not change this project's version choice.
Third-party dependencies retain their own licenses.

Distribute source from a reviewed Git revision, with the license and the source
and build scripts needed under the GPL. Do not archive an everyday working
directory: ignored `.env` files, local configuration, databases, Projects, model
files, Reference Assets, and generated outputs are not source-distribution inputs.
Include only deliberately reviewed, redistributable test fixtures. Review built
packages separately for required license notices and accidental local data.

Frontend builds include the project license and bundled dependency/tool notices.
The backend wheel and sdist include the complete project license with GPL-3.0-only
metadata. Automated distribution checks inspect these artifacts and reject notice
drift or unexpected inputs. Keep those notices with redistributed builds; they do
not replace the GPL requirement to provide corresponding source or cover separately
bundled Python dependencies, browsers, models, or OS components.

Public diagnostic responses omit raw exception and upstream text. Controlled HTTP
application and background-task failure logs retain safe failure categories and
locations instead of exception values. This is not disk-wide redaction: historical
execution evidence, access logs, startup errors, and independent dependency logs
can still be sensitive. Review them before sharing.

Never put secrets in `VITE_*` variables; they are exposed to the browser. The two
tracked frontend environment files contain public defaults only. Ignore rules do
not protect files already tracked by Git or erase earlier commits.

CI runs checksum-pinned Gitleaks against the current checkout and all fetched Git
history with findings redacted. It does not treat personal names or email addresses
as credentials, and it is not a complete privacy or dependency audit. Review source,
Git metadata, and release artifacts before publishing. If a credential is exposed,
revoke or rotate it first; removing it from the current tree does not remove it
from history. Coordinate any history rewrite explicitly with repository owners.
