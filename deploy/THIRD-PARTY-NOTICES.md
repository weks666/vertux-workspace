# Browser seccomp profile

`lead-browser-seccomp.json` is derived from
[Microsoft Playwright v1.64.0 seccomp_profile.json](https://github.com/microsoft/playwright/blob/v1.64.0/utils/docker/seccomp_profile.json).

Copyright Microsoft Corporation. Licensed under Apache License 2.0; see
[PLAYWRIGHT-LICENSE.txt](PLAYWRIGHT-LICENSE.txt). SHA-256 of the unmodified upstream profile:
`cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`.

Modified by Vertux on 2026-10-11. In the `chroot` syscall rule, the
`includes.caps=["CAP_SYS_CHROOT"]` condition was replaced with an empty `includes`
object, and a comment explaining the local change was added. A semantic JSON
comparison against the versioned upstream file confirmed no other changes.
SHA-256 of the modified local profile:
`742f5d0f54ade8ffbdc7de728252f39cb605c93a6bbf4d653214ebc243d340fd`.

The local exception allows Chromium's nested user-namespace sandbox to call
`chroot` while the outer container retains `--cap-drop=ALL`. It does not add a
container or host capability. Linux still performs the syscall's namespace
capability and LSM checks. The exception allows the syscall generally; it is not
a pathname-specific filter. See
[Chromium credentials.cc](https://github.com/chromium/chromium/blob/main/sandbox/linux/services/credentials.cc),
[Linux chroot implementation](https://github.com/torvalds/linux/blob/master/fs/open.c),
and the deployment constraints in [lead-browser.md](../docs/lead-browser.md).

This notice applies to that third-party file and does not assign a license to
the Workspace repository.
