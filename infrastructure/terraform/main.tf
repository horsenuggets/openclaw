terraform {
  required_version = ">= 1.5"

  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

provider "github" {
  owner = "horsenuggets"
  # Authenticates via GITHUB_TOKEN environment variable
}

locals {
  repo_name = "openclaw"

  # CI checks required for both main and release
  required_checks = [
    "install-check",
    "checks (node, tsgo, pnpm tsgo)",
    "checks (node, lint, pnpm build && pnpm lint)",
    "checks (node, test, pnpm canvas:a2ui:bundle && pnpm test)",
    "checks (node, format, pnpm format)",
    "checks (node, protocol, pnpm protocol:check)",
    "checks (bun, test, pnpm canvas:a2ui:bundle && bunx vitest run)",
    "secrets",
    "no-tabs",
  ]

  # Additional checks required only for release PRs
  release_checks = concat(local.required_checks, [
    "Validate PR title",
    "Verify diff matches main",
    "Validate version",
    "Verify deploy target",
  ])
}

# Repository settings — match existing config, only manage what we need
resource "github_repository" "openclaw" {
  name         = local.repo_name
  homepage_url = "https://openclaw.ai"
  visibility   = "public"

  has_issues   = false
  has_projects = true
  has_wiki     = false

  allow_squash_merge = true
  allow_merge_commit = false
  allow_rebase_merge = false

  squash_merge_commit_title   = "PR_TITLE"
  squash_merge_commit_message = "PR_BODY"

  delete_branch_on_merge = true

  # Preserve existing pages config
  pages {
    build_type = "legacy"
    source {
      branch = "gh-pages"
      path   = "/"
    }
  }

  lifecycle {
    ignore_changes = [
      description,
      visibility,
      topics,
      has_downloads,
    ]
  }
}

# Branch protection for main — no direct pushes, require CI checks
resource "github_repository_ruleset" "main" {
  name        = "main"
  repository  = github_repository.openclaw.name
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["~DEFAULT_BRANCH"]
      exclude = []
    }
  }

  rules {
    pull_request {
      required_approving_review_count = 0
      dismiss_stale_reviews_on_push   = true
    }

    # Automatically request Copilot code review on every PR
    copilot_code_review {
      review_on_push             = true
      review_draft_pull_requests = false
    }

    required_status_checks {
      dynamic "required_check" {
        for_each = local.required_checks
        content {
          context        = required_check.value
          integration_id = 0
        }
      }
    }
  }
}

# Branch protection for release — same as main + version/diff/deploy checks
resource "github_repository_ruleset" "release" {
  name        = "release"
  repository  = github_repository.openclaw.name
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/heads/release"]
      exclude = []
    }
  }

  rules {
    pull_request {
      required_approving_review_count = 0
      dismiss_stale_reviews_on_push   = true
    }

    # Automatically request Copilot code review on every PR
    copilot_code_review {
      review_on_push             = true
      review_draft_pull_requests = false
    }

    required_status_checks {
      dynamic "required_check" {
        for_each = local.release_checks
        content {
          context        = required_check.value
          integration_id = 0
        }
      }
    }
  }
}

# Branch protection for gh-pages — no force pushes, no deletions
resource "github_repository_ruleset" "ghpages" {
  name        = "gh-pages"
  repository  = github_repository.openclaw.name
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/heads/gh-pages"]
      exclude = []
    }
  }

  rules {
    # Require PRs (prevents direct pushes including from admins)
    pull_request {
      required_approving_review_count = 0
      dismiss_stale_reviews_on_push   = true
    }
  }
}
