# Contributing

Thank you for your interest in contributing!

## Reporting Issues

- Search existing issues before opening a new one
- Include steps to reproduce, expected behavior, and actual behavior
- For bugs, include your environment (Bun version, OS, etc.)

## Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Run tests and linting:
   ```bash
   bun test
   bun run lint
   ```
5. Commit using [Conventional Commits](https://www.conventionalcommits.org/) format:
   - `feat: add new feature`
   - `fix: resolve bug`
   - `docs: update readme`
   - `chore: update dependencies`
6. Push and open a Pull Request

## Pull Request Guidelines

- Prefer Conventional Commits for PR titles and commits.
- Keep PRs focused on a single change
- Include tests for new functionality
- Ensure all checks pass before requesting review

## Code Style

This project uses ESLint and Prettier. Run `bun run lint:fix` to auto-fix lint issues and `bun run format` to format files.

See [AGENTS.md](./AGENTS.md) for detailed code style guidelines.
