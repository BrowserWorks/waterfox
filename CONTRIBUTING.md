# Contributing to Waterfox

Thank you for your interest in contributing to Waterfox! This guide will help you understand our contribution process and how to effectively work with our codebase.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Pull Request Process](#pull-request-process)
- [Managing Upstream Changes](#managing-upstream-changes)
- [Contribution Guidelines](#contribution-guidelines)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)

## Code of Conduct

Don't be an ass. We are all human.

## Getting Started

Before contributing, please:

1. Fork the repository
2. Set up your development environment following our [Build Guide](BUILDING.md)
3. Create a new branch for your changes
4. Make your changes
5. Test thoroughly

## Pull Request Process

We welcome pull requests but have a few important considerations:

1. **Limited Review Bandwidth**: The core team has limited availability to review PRs. While we appreciate your contributions, please understand that it may take time for your PR to be reviewed and merged.

2. **Not All PRs Will Be Accepted**: We maintain specific technical and design directions for Waterfox. Even well-implemented features might not be accepted if they don't align with this direction. Please don't be discouraged if your PR is declined.

3. **PR Requirements**:
   - Ensure your code follows our coding style
   - Include tests where appropriate
   - Update documentation to reflect any changes
   - Keep PRs focused on a single issue/feature
   - Provide a clear description explaining the purpose and implementation details

4. **Review Process**:
   - PRs require approval from at least one maintainer
   - You may be asked to make changes before your PR is accepted
   - Please respond to review comments in a timely manner

## Managing Upstream Changes

Waterfox is based on Firefox, and we maintain our changes as commits on top of the upstream codebase. This creates some complexity when working with the repository:

### How Our Update Process Works

1. We regularly pull in upstream changes from Firefox
2. We rebase our Waterfox-specific changes on top of these updates
3. This rebasing changes the commit hashes of our modifications
4. As a result, simple `git pull` operations can lead to significant merge conflicts

### Keeping Your Fork in Sync

If you're working on a contribution, follow these steps to avoid headaches:

#### Before Starting New Work

```bash
# Ensure you have the Waterfox repo as a remote
git remote add upstream https://github.com/BrowserWorks/Waterfox.git

# Fetch the latest changes
git fetch upstream

# Reset your main branch to match upstream
git checkout main
git reset --hard upstream/main

# Create a new branch for your work
git checkout -b my-feature-branch
```

#### During Active Development (When Upstream Changes)

If you're in the middle of development and the upstream Waterfox repository has changed:

```bash
# Stash any uncommitted changes
git stash

# Update your main branch
git checkout main
git fetch upstream
git reset --hard upstream/main

# Rebase your feature branch
git checkout my-feature-branch
git rebase main

# Resolve any conflicts that arise during rebase
# After resolving each file:
git add <resolved-file>
git rebase --continue

# Restore your stashed changes if needed
git stash pop
```

#### Alternative: Branch from Main and Cherry-Pick

Sometimes a full rebase is too complex. In that case:

```bash
# Create a new branch from updated main
git checkout main
git pull upstream main
git checkout -b my-feature-branch-new

# Cherry-pick your commits from the old branch
git cherry-pick <commit-hash>
# Resolve conflicts as needed

# Once all commits are transferred, you can continue work on the new branch
```

### Identifying Your Changes After Upstream Updates

After a major upstream update, finding your specific changes can be challenging. These approaches may help:

1. **Use commit messages**: Maintain descriptive commit messages that clearly identify Waterfox-specific changes
2. **Create feature branches**: Keep work isolated in feature branches before submitting PRs
3. **Use git blame with caution**: The rebasing process changes commit hashes, so `git blame` might not show the original author

## Contribution Guidelines

### Code Style

- Follow the existing code style in the files you're modifying
- For JavaScript/C++, we generally follow [Mozilla's coding style](https://firefox-source-docs.mozilla.org/code-quality/coding-style/index.html)
- Use meaningful variable names and add comments for complex logic

### Commit Messages

- Use clear, descriptive commit messages
- Start with a conventional commit type prefix:
  - `fix:` for bug fixes
  - `feat:` for new features
  - `docs:` for documentation changes
  - `style:` for formatting, missing semi-colons, etc.
  - `refactor:` for code changes that neither fix bugs nor add features
  - `perf:` for performance improvements
  - `test:` for adding or correcting tests
  - `chore:` for routine tasks, dependency updates, etc.
  - `ci:` for CI/CD related changes
- After the prefix, provide a brief summary (50 chars or less)
- If needed, provide a more detailed explanation after a blank line
- **Important:** Do not reference issue numbers in commit messages to avoid notification spam during rebases

### Documentation

- Update documentation to reflect your changes
- Add comments to explain non-obvious code sections
- If adding new features, update relevant README or documentation files

## Reporting Bugs

When reporting bugs:

1. Use the GitHub Issues tracker
2. Check if the issue already exists before creating a new one
3. Include detailed steps to reproduce
4. Provide system information (OS, Waterfox version, etc.)
5. Include screenshots or videos if applicable

## Suggesting Features

We welcome feature suggestions:

1. First, check if the feature has already been suggested
2. Provide a clear description of the feature and its benefits
3. Understand that not all features will be implemented, based on our priorities and resources

Thank you for contributing to Waterfox!
