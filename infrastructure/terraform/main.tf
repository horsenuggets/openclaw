#
# main.tf
#
# Manages this repository's GitHub settings, including merge options, Pages, and the
# rulesets that protect main, release, and gh-pages. Run plans and applies from this
# folder with GITHUB_TOKEN set, for example...
#
#   GITHUB_TOKEN=$(gh auth token) terraform plan
#

terraform {
    required_version = ">= 1.5"

    # State lives in HCP Terraform. The organization comes from the TF_CLOUD_ORGANIZATION
    # environment variable, and plans run locally.
    cloud {
        workspaces {
            name = "openclaw"
        }
    }

    required_providers {
        github = {
            source = "integrations/github"
            version = "~> 6.0"
        }
    }
}

provider "github" {
    # Authenticates via the GITHUB_TOKEN environment variable.
    owner = "horsenuggets"
}

locals {
    repo_name = "openclaw"

    # CI checks required for every PR. The cross-platform compile matrix is intentionally
    # disabled to conserve CI minutes, so only linux-arm64 (the cheapest runner) is built
    # until we decide whether to keep Node SEA or migrate back to Bun.
    main_checks = [
        "install-check",
        "checks (node, tsgo, pnpm tsgo)",
        "checks (node, lint, pnpm build && pnpm lint)",
        "checks (node, test:extensions, pnpm canvas:a2ui:bundle && pnpm test:extensions)",
        "checks (node, test:gateway, pnpm canvas:a2ui:bundle && pnpm test:gateway)",
        "checks (node, test:unit (1/4), pnpm canvas:a2ui:bundle && pnpm test:unit --shard 1/4)",
        "checks (node, test:unit (2/4), pnpm canvas:a2ui:bundle && pnpm test:unit --shard 2/4)",
        "checks (node, test:unit (3/4), pnpm canvas:a2ui:bundle && pnpm test:unit --shard 3/4)",
        "checks (node, test:unit (4/4), pnpm canvas:a2ui:bundle && pnpm test:unit --shard 4/4)",
        "checks (node, format, pnpm format)",
        "checks (node, protocol, pnpm protocol:check)",
        "Compile & smoke test (linux-arm64)",
        "secrets",
        "no-tabs"
    ]

    # Additional checks required only for release PRs.
    release_checks = concat(local.main_checks, [
        "Validate PR title",
        "Verify diff matches main",
        "Validate version",
        "Verify deploy target"
    ])
}

# Adopt the existing repository instead of trying to create it. The id must be a literal
# string on Terraform 1.5, so keep it in sync with local.repo_name.
import {
    to = github_repository.repo
    id = "openclaw"
}

resource "github_repository" "repo" {
    name = local.repo_name

    has_issues = false
    has_projects = true
    has_wiki = false

    allow_squash_merge = true
    allow_merge_commit = false
    allow_rebase_merge = false

    squash_merge_commit_title = "PR_TITLE"
    squash_merge_commit_message = "PR_BODY"

    delete_branch_on_merge = true

    pages {
        build_type = "legacy"
        source {
            branch = "gh-pages"
            path = "/"
        }
    }

    lifecycle {
        # Destroying this resource would delete the repository on GitHub.
        prevent_destroy = true

        # Managed in the GitHub UI, so applies don't overwrite them.
        ignore_changes = [allow_auto_merge, description, topics, visibility]
    }
}

resource "github_repository_ruleset" "main" {
    name = "main"
    repository = github_repository.repo.name
    target = "branch"
    enforcement = "active"

    conditions {
        ref_name {
            include = ["~DEFAULT_BRANCH"]
            exclude = []
        }
    }

    rules {
        non_fast_forward = true
        deletion = true

        pull_request {
            required_approving_review_count = 0
            dismiss_stale_reviews_on_push = true
        }

        required_status_checks {
            strict_required_status_checks_policy = true

            dynamic "required_check" {
                for_each = local.main_checks
                content {
                    context = required_check.value
                    integration_id = 15368
                }
            }
        }
    }
}

resource "github_repository_ruleset" "release" {
    name = "release"
    repository = github_repository.repo.name
    target = "branch"
    enforcement = "active"

    conditions {
        ref_name {
            include = ["refs/heads/release"]
            exclude = []
        }
    }

    rules {
        non_fast_forward = true
        deletion = true

        pull_request {
            required_approving_review_count = 0
            dismiss_stale_reviews_on_push = true
        }

        required_status_checks {
            strict_required_status_checks_policy = true

            dynamic "required_check" {
                for_each = local.release_checks
                content {
                    context = required_check.value
                    integration_id = 15368
                }
            }
        }
    }
}

# Requires a PR for gh-pages, which blocks direct pushes, including from admins.
resource "github_repository_ruleset" "ghpages" {
    name = "gh-pages"
    repository = github_repository.repo.name
    target = "branch"
    enforcement = "active"

    conditions {
        ref_name {
            include = ["refs/heads/gh-pages"]
            exclude = []
        }
    }

    rules {
        pull_request {
            required_approving_review_count = 0
            dismiss_stale_reviews_on_push = true
        }
    }
}
