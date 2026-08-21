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

## Breaking change: `getAccessToken` no longer trusts caller-supplied project identity

For security reasons, `getAccessToken` now validates any caller-supplied `projectKey` against an allowlist
derived from the build's own JWT (`getAuthorizedProjectKeys`), and only trusts it when it also matches the
build's own configured coverage scope; an unauthorized key is rejected with a `403`, and an
authorized-but-wrong-scope key is ignored (logged as a mismatch, not enforced). `projectName` and `username`
are never trusted at all — both are always derived. `username` is checked against the derived value and
triggers the mismatch warning on its own; `projectName` is accepted only for backward compatibility and is
included in that warning's message text when one fires, but a stale or bogus `projectName` alone does not
trigger it.

A caller that still sends only the old resolved tuple (`projectKey`/`username`/`projectName`, no
`pipelineName`) will still successfully mint a token, but the Git App binding (`configureGitApp`) may be
skipped for newly created enterprise projects, since it now depends on a resolved `pipelineName` rather than
a caller-supplied `projectName`. See the `getAccessToken` JSDoc in `index.js` for the full parameter contract.

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
