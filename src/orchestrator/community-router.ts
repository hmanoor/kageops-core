/**
 * KageOps Community Router
 *
 * Routes tasks to agents based on code community ownership derived from
 * the architecture overview (code-review-graph communities).
 */

// ── Types ────────────────────────────────────────────

export interface CommunityOwnership {
  readonly communityName: string;
  readonly files: readonly string[];
  readonly primaryAgent: string;
  readonly reason: string;
}

export interface CommunityRouteResult {
  readonly suggestedAgent: string;
  readonly confidence: number; // 0-1
  readonly matchedCommunity: string | null;
  readonly reason: string;
}

// ── Community → Agent Map ────────────────────────────

export const COMMUNITY_AGENT_MAP: readonly {
  pattern: RegExp;
  agent: string;
  reason: string;
}[] = [
  {
    pattern: /test|spec|vitest|jest|coverage/i,
    agent: 'vigil',
    reason: 'Testing community',
  },
  {
    pattern: /ci|cd|docker|deploy|infra|terraform|github.actions|workflow/i,
    agent: 'aegis',
    reason: 'Infrastructure community',
  },
  {
    pattern: /ui|ux|design|component|style|css|layout|render/i,
    agent: 'pixel',
    reason: 'UI/Design community',
  },
  {
    pattern: /db|database|schema|migration|query|sql|postgres/i,
    agent: 'cipher',
    reason: 'Data community',
  },
  {
    pattern: /api|endpoint|route|controller|middleware|auth/i,
    agent: 'forge',
    reason: 'Backend engineering community',
  },
  {
    pattern: /doc|readme|guide|tutorial|changelog/i,
    agent: 'herald',
    reason: 'Documentation community',
  },
  {
    pattern: /architect|design|system|overview|decision/i,
    agent: 'blueprint',
    reason: 'Architecture community',
  },
  {
    pattern: /market|launch|growth|analytics|metric/i,
    agent: 'scout',
    reason: 'Strategy community',
  },
];

// ── Functions ─────────────────────────────────────────

/**
 * Classify a community to an agent by checking community name first,
 * then individual file paths. Falls back to 'forge'.
 */
export function classifyCommunity(
  communityName: string,
  files: readonly string[],
): string {
  // Check community name first
  for (const entry of COMMUNITY_AGENT_MAP) {
    if (entry.pattern.test(communityName)) {
      return entry.agent;
    }
  }

  // Check file paths
  for (const file of files) {
    for (const entry of COMMUNITY_AGENT_MAP) {
      if (entry.pattern.test(file)) {
        return entry.agent;
      }
    }
  }

  return 'forge';
}

/**
 * Build a community ownership map from architecture overview communities.
 */
export function buildCommunityOwnershipMap(
  communities: readonly {
    name: string;
    files: readonly string[];
    cohesion: number;
  }[],
): readonly CommunityOwnership[] {
  return communities.map((community) => {
    const agent = classifyCommunity(community.name, community.files);
    const mapEntry = COMMUNITY_AGENT_MAP.find((e) => e.agent === agent);
    const reason = mapEntry?.reason ?? 'General engineering community';

    return {
      communityName: community.name,
      files: community.files,
      primaryAgent: agent,
      reason,
    };
  });
}

/**
 * Route a task by the files it touches — finds the community with the most
 * overlap and returns its owning agent with confidence = matched / total.
 */
export function routeByFiles(
  taskFiles: readonly string[],
  ownershipMap: readonly CommunityOwnership[],
): CommunityRouteResult {
  if (taskFiles.length === 0) {
    return {
      suggestedAgent: 'forge',
      confidence: 0,
      matchedCommunity: null,
      reason: 'No files provided — defaulting to forge',
    };
  }

  // Count overlapping files per community
  const scores = ownershipMap.map((ownership) => {
    const matched = taskFiles.filter((f) => ownership.files.includes(f)).length;
    return { ownership, matched };
  });

  const best = scores.reduce(
    (prev, curr) => (curr.matched > prev.matched ? curr : prev),
    scores[0] ?? { ownership: null, matched: 0 },
  );

  if (!best.ownership || best.matched === 0) {
    return {
      suggestedAgent: 'forge',
      confidence: 0,
      matchedCommunity: null,
      reason: 'No community overlap found — defaulting to forge',
    };
  }

  const confidence = best.matched / taskFiles.length;

  return {
    suggestedAgent: best.ownership.primaryAgent,
    confidence,
    matchedCommunity: best.ownership.communityName,
    reason: `${best.matched}/${taskFiles.length} files matched community "${best.ownership.communityName}" (${best.ownership.reason})`,
  };
}

/**
 * Route a task by description keywords when no file info is available.
 * Returns lower confidence (0.3–0.6) than file-based routing.
 */
export function routeByDescription(
  taskDescription: string,
  taskType: string,
): CommunityRouteResult {
  const combined = `${taskType} ${taskDescription}`;

  for (const entry of COMMUNITY_AGENT_MAP) {
    if (entry.pattern.test(combined)) {
      return {
        suggestedAgent: entry.agent,
        confidence: 0.5,
        matchedCommunity: null,
        reason: `Keyword match in description — ${entry.reason}`,
      };
    }
  }

  return {
    suggestedAgent: 'forge',
    confidence: 0.3,
    matchedCommunity: null,
    reason: 'No keyword match — defaulting to forge with low confidence',
  };
}

/**
 * Merge community routing with the speciality matrix result.
 *
 * - Community wins when confidence > 0.7
 * - Matrix wins when community confidence < 0.3
 * - Weighted blend in the middle range
 */
export function mergeRouteSignals(
  communityResult: CommunityRouteResult | null,
  matrixResult: { agent: string; score: number } | null,
): { agent: string; confidence: number; reason: string } {
  if (!communityResult && !matrixResult) {
    return {
      agent: 'forge',
      confidence: 0,
      reason: 'No routing signals available — defaulting to forge',
    };
  }

  if (!communityResult) {
    return {
      agent: matrixResult!.agent,
      confidence: matrixResult!.score,
      reason: 'No community signal — using speciality matrix result',
    };
  }

  if (!matrixResult) {
    return {
      agent: communityResult.suggestedAgent,
      confidence: communityResult.confidence,
      reason: 'No matrix signal — using community routing result',
    };
  }

  if (communityResult.confidence > 0.7) {
    return {
      agent: communityResult.suggestedAgent,
      confidence: communityResult.confidence,
      reason: `Community routing wins (confidence ${communityResult.confidence.toFixed(2)} > 0.7) — ${communityResult.reason}`,
    };
  }

  if (communityResult.confidence < 0.3) {
    return {
      agent: matrixResult.agent,
      confidence: matrixResult.score,
      reason: `Matrix routing wins (community confidence ${communityResult.confidence.toFixed(2)} < 0.3) — ${communityResult.reason}`,
    };
  }

  // Weighted blend: community weight proportional to its confidence
  const communityWeight = communityResult.confidence;
  const matrixWeight = 1 - communityWeight;

  // Pick the higher-weighted agent; if same agent, blend confidence
  if (communityResult.suggestedAgent === matrixResult.agent) {
    const blendedConfidence =
      communityResult.confidence * communityWeight +
      matrixResult.score * matrixWeight;
    return {
      agent: communityResult.suggestedAgent,
      confidence: Math.min(1, blendedConfidence),
      reason: `Both signals agree on ${communityResult.suggestedAgent} — blended confidence`,
    };
  }

  const communityScore = communityResult.confidence * communityWeight;
  const matrixScore = matrixResult.score * matrixWeight;

  if (communityScore >= matrixScore) {
    return {
      agent: communityResult.suggestedAgent,
      confidence: communityResult.confidence,
      reason: `Blended: community signal (${communityResult.confidence.toFixed(2)}) outweighs matrix — ${communityResult.reason}`,
    };
  }

  return {
    agent: matrixResult.agent,
    confidence: matrixResult.score,
    reason: `Blended: matrix signal outweighs community (${communityResult.confidence.toFixed(2)}) — using ${matrixResult.agent}`,
  };
}
