# Roadmap

This repo is being taken toward an OpenCode-first GPT Pro workflow.

That does not mean throwing away the upstream Oracle engine. It means using the upstream engine as infrastructure while reshaping the product surface around the workflow that matters here: OpenCode drives the task, local files are the source of truth, and GPT Pro in ChatGPT is the execution target.

## North star

Make GPT Pro usable from OpenCode with a handoff that is:

- browser-native
- stateful across long sessions
- bounded in local context size
- reproducible from repo artifacts rather than one-off machine surgery

## Near-term work

### 1. Stabilize the OpenCode handoff

- keep the forwarded session bundle under Oracle's local attachment limit
- preserve recent context while degrading older context in a controlled way
- document the install path so the integration can be reapplied on a fresh machine

### 2. Make browser GPT Pro the default path

- prefer ChatGPT browser workflows where GPT Pro availability lives
- keep the active ChatGPT model instead of repeatedly forcing reselection
- improve recovery around long runs, reattach, and profile reuse

### 3. Turn fork-local tweaks into product surface

- move important behavior out of ad hoc home-directory files where possible
- reduce the number of manual copy steps required to get OpenCode working
- expose tuning through clear config or install commands rather than hidden patches

## Medium-term direction

### OpenCode as the primary integration target

The fork should read like a toolchain for OpenCode, not just a generic CLI that happens to have a bridge example. That means the docs, defaults, examples, and failure handling should all assume the OpenCode loop first.

### Selective divergence from upstream

The plan is not to fork every upstream feature into a different philosophy. The plan is to keep what remains useful and diverge where the OpenCode + GPT Pro workflow has different reliability requirements.

### Better context semantics

The current compaction pass is deterministic. That is the right starting point. Later work may add opt-in semantic summaries or cached lineage digests, but only if they improve reliability without turning every consult into a multi-stage hidden pipeline.

## Non-goals for now

- removing Oracle's API and multi-model capabilities
- pretending this fork is already a new published package
- rewriting the entire upstream codebase before the OpenCode path is stable
- adding LLM summarization everywhere just because the context is large

## Packaging stance

For now, the repo name is `opencode-gpt-pro`, while the package and binary remain `@steipete/oracle` and `oracle`.

That split is intentional during the transition. The working priority is a reliable OpenCode workflow. Naming and publication can be cleaned up once the behavioral surface is settled.
