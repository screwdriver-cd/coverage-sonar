# Coverage Sonar Plugin
[![Version][npm-image]][npm-url] ![Downloads][downloads-image] [![Build Status][status-image]][status-url] [![Open Issues][issues-image]][issues-url] ![License][license-image]

> SonarQube implementation of the coverage-base class

## Usage

```bash
npm install screwdriver-coverage-sonar
```

## Testing

```bash
npm test
```

## BREAKING CHANGE: `getAccessToken` no longer trusts caller-supplied project identity

For security reasons ([PSECBUGS-115276](https://github.com/screwdriver-cd/screwdriver/pull/3518)),
`getAccessToken` now validates any caller-supplied `projectKey` against an allowlist derived from the
build's own JWT (`getAuthorizedProjectKeys`), and rejects it with a `403` unless it also matches the
build's own configured coverage scope — its own pipeline and its own job are both always "authorized," so
without the scope check a build could still cross between the two. `projectName` and `username` are never
trusted at all — both are always derived. `username` is checked against the derived value and triggers a
mismatch warning on its own; `projectName` is accepted only for backward compatibility and is included in
that warning's message text when one fires, but a stale or bogus `projectName` alone does not trigger it.

A caller that still sends only the old resolved tuple (`projectKey`/`username`/`projectName`, no
`pipelineName`) will still successfully mint a token, but the Git App binding (`configureGitApp`) may be
skipped for newly created enterprise projects, since it now depends on a resolved `pipelineName` rather than
a caller-supplied `projectName`. See the `getAccessToken` JSDoc in `index.js` for the full parameter contract.

### Deployment order

This release requires [screwdriver-cd/screwdriver#3518](https://github.com/screwdriver-cd/screwdriver/pull/3518)
to already be deployed. Before #3518, the API's `/coverage/token` route only sends `pipelineName` when the
caller-supplied `projectName` is absent or malformed — so against an un-upgraded API, every `projectKey`
this plugin receives resolves to an authorized, scope-matching key with no `pipelineName`, and the Git App
binding is silently skipped for newly created enterprise projects (existing bindings are unaffected). No
build is rejected and no token request fails; the only symptom is that PR decoration doesn't get configured.
Deploy #3518 first, then upgrade this dependency.

## Related Links
- See [coverage-base](https://github.com/screwdriver-cd/coverage-base)

## License

Code licensed under the BSD 3-Clause license. See LICENSE file for terms.

[npm-image]: https://img.shields.io/npm/v/screwdriver-coverage-sonar.svg
[npm-url]: https://npmjs.org/package/screwdriver-coverage-sonar
[downloads-image]: https://img.shields.io/npm/dt/screwdriver-coverage-sonar.svg
[license-image]: https://img.shields.io/npm/l/screwdriver-coverage-sonar.svg
[issues-image]: https://img.shields.io/github/issues/screwdriver-cd/coverage-sonar.svg
[issues-url]: https://github.com/screwdriver-cd/coverage-sonar/issues
[status-image]: https://cd.screwdriver.cd/pipelines/706/badge
[status-url]: https://cd.screwdriver.cd/pipelines/706
