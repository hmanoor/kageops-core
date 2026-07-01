-- ═══════════════════════════════════════════════════════
--  KageOps Seed Data
--  Default speciality matrix scores for all 8 agents
-- ═══════════════════════════════════════════════════════

-- Clear existing matrix data for clean re-seed
DELETE FROM speciality_matrix;

-- ── Scout (Strategist) ────────────────────────────────
INSERT INTO speciality_matrix (agent, skill, score) VALUES
    ('scout', 'market-research', 9.0),
    ('scout', 'competitive-analysis', 9.0),
    ('scout', 'prd-writing', 9.0),
    ('scout', 'requirements-gathering', 8.0),
    ('scout', 'feasibility-assessment', 8.0),
    ('scout', 'project-planning', 8.0),
    ('scout', 'sprint-management', 7.0),
    ('scout', 'user-stories', 8.0),
    ('scout', 'risk-assessment', 7.0),
    ('scout', 'react-nextjs', 2.0),
    ('scout', 'spark-databricks', 1.0),
    ('scout', 'terraform-iac', 0.0),
    ('scout', 'api-design', 4.0),
    ('scout', 'ui-wireframing', 3.0),
    ('scout', 'security-review', 1.0),
    ('scout', 'marketing-copy', 2.0),
    ('scout', 'typescript', 3.0),
    ('scout', 'python', 3.0),
    ('scout', 'docker', 1.0),
    ('scout', 'testing', 2.0);

-- ── Blueprint (Architect) ─────────────────────────────
INSERT INTO speciality_matrix (agent, skill, score) VALUES
    ('blueprint', 'system-design', 9.0),
    ('blueprint', 'tech-stack-selection', 8.0),
    ('blueprint', 'api-design', 8.0),
    ('blueprint', 'database-design', 8.0),
    ('blueprint', 'infrastructure-planning', 7.0),
    ('blueprint', 'architecture-review', 9.0),
    ('blueprint', 'tradeoff-analysis', 8.0),
    ('blueprint', 'scalability-planning', 8.0),
    ('blueprint', 'react-nextjs', 4.0),
    ('blueprint', 'spark-databricks', 3.0),
    ('blueprint', 'terraform-iac', 5.0),
    ('blueprint', 'prd-writing', 3.0),
    ('blueprint', 'ui-wireframing', 2.0),
    ('blueprint', 'security-review', 5.0),
    ('blueprint', 'marketing-copy', 0.0),
    ('blueprint', 'typescript', 6.0),
    ('blueprint', 'python', 5.0),
    ('blueprint', 'docker', 5.0),
    ('blueprint', 'testing', 5.0);

-- ── Pixel (Designer) ─────────────────────────────────
INSERT INTO speciality_matrix (agent, skill, score) VALUES
    ('pixel', 'ui-wireframing', 9.0),
    ('pixel', 'ux-design', 9.0),
    ('pixel', 'visual-design', 9.0),
    ('pixel', 'design-systems', 8.0),
    ('pixel', 'prototyping', 8.0),
    ('pixel', 'user-research', 7.0),
    ('pixel', 'accessibility', 7.0),
    ('pixel', 'react-nextjs', 6.0),
    ('pixel', 'css-styling', 9.0),
    ('pixel', 'spark-databricks', 0.0),
    ('pixel', 'terraform-iac', 0.0),
    ('pixel', 'prd-writing', 2.0),
    ('pixel', 'api-design', 1.0),
    ('pixel', 'security-review', 0.0),
    ('pixel', 'marketing-copy', 3.0),
    ('pixel', 'typescript', 5.0),
    ('pixel', 'python', 2.0),
    ('pixel', 'docker', 1.0),
    ('pixel', 'testing', 4.0);

-- ── Forge (Engineer) ──────────────────────────────────
INSERT INTO speciality_matrix (agent, skill, score) VALUES
    ('forge', 'typescript', 9.0),
    ('forge', 'javascript', 9.0),
    ('forge', 'python', 8.0),
    ('forge', 'react-nextjs', 9.0),
    ('forge', 'nodejs', 9.0),
    ('forge', 'api-development', 9.0),
    ('forge', 'database-queries', 8.0),
    ('forge', 'testing', 8.0),
    ('forge', 'refactoring', 8.0),
    ('forge', 'debugging', 9.0),
    ('forge', 'git', 8.0),
    ('forge', 'spark-databricks', 3.0),
    ('forge', 'terraform-iac', 2.0),
    ('forge', 'prd-writing', 1.0),
    ('forge', 'ui-wireframing', 3.0),
    ('forge', 'api-design', 9.0),
    ('forge', 'security-review', 5.0),
    ('forge', 'marketing-copy', 0.0),
    ('forge', 'docker', 5.0);

-- ── Cipher (Data Specialist) ──────────────────────────
INSERT INTO speciality_matrix (agent, skill, score) VALUES
    ('cipher', 'spark-databricks', 9.0),
    ('cipher', 'data-pipelines', 9.0),
    ('cipher', 'sql', 9.0),
    ('cipher', 'data-modeling', 8.0),
    ('cipher', 'etl', 9.0),
    ('cipher', 'machine-learning', 7.0),
    ('cipher', 'data-visualization', 7.0),
    ('cipher', 'database-queries', 9.0),
    ('cipher', 'python', 8.0),
    ('cipher', 'react-nextjs', 1.0),
    ('cipher', 'terraform-iac', 1.0),
    ('cipher', 'prd-writing', 1.0),
    ('cipher', 'ui-wireframing', 0.0),
    ('cipher', 'api-design', 3.0),
    ('cipher', 'security-review', 2.0),
    ('cipher', 'marketing-copy', 0.0),
    ('cipher', 'typescript', 5.0),
    ('cipher', 'docker', 3.0),
    ('cipher', 'testing', 4.0);

-- ── Aegis (Platform Engineer) ─────────────────────────
INSERT INTO speciality_matrix (agent, skill, score) VALUES
    ('aegis', 'docker', 9.0),
    ('aegis', 'terraform-iac', 9.0),
    ('aegis', 'ci-cd', 9.0),
    ('aegis', 'github-actions', 9.0),
    ('aegis', 'azure', 8.0),
    ('aegis', 'kubernetes', 8.0),
    ('aegis', 'monitoring', 8.0),
    ('aegis', 'networking', 7.0),
    ('aegis', 'security-hardening', 8.0),
    ('aegis', 'deployment', 9.0),
    ('aegis', 'react-nextjs', 3.0),
    ('aegis', 'spark-databricks', 2.0),
    ('aegis', 'prd-writing', 0.0),
    ('aegis', 'ui-wireframing', 0.0),
    ('aegis', 'api-design', 3.0),
    ('aegis', 'security-review', 6.0),
    ('aegis', 'marketing-copy', 0.0),
    ('aegis', 'typescript', 4.0),
    ('aegis', 'python', 4.0),
    ('aegis', 'testing', 5.0);

-- ── Vigil (Quality Guardian) ──────────────────────────
INSERT INTO speciality_matrix (agent, skill, score) VALUES
    ('vigil', 'code-review', 9.0),
    ('vigil', 'testing', 9.0),
    ('vigil', 'security-review', 9.0),
    ('vigil', 'documentation', 8.0),
    ('vigil', 'compliance', 7.0),
    ('vigil', 'performance-testing', 8.0),
    ('vigil', 'accessibility', 7.0),
    ('vigil', 'test-automation', 8.0),
    ('vigil', 'react-nextjs', 6.0),
    ('vigil', 'spark-databricks', 4.0),
    ('vigil', 'terraform-iac', 5.0),
    ('vigil', 'prd-writing', 5.0),
    ('vigil', 'ui-wireframing', 4.0),
    ('vigil', 'api-design', 6.0),
    ('vigil', 'marketing-copy', 3.0),
    ('vigil', 'typescript', 7.0),
    ('vigil', 'python', 6.0),
    ('vigil', 'docker', 4.0);

-- ── Herald (Marketer) ─────────────────────────────────
INSERT INTO speciality_matrix (agent, skill, score) VALUES
    ('herald', 'marketing-copy', 9.0),
    ('herald', 'brand-strategy', 9.0),
    ('herald', 'content-creation', 9.0),
    ('herald', 'seo', 8.0),
    ('herald', 'social-media', 8.0),
    ('herald', 'campaign-management', 8.0),
    ('herald', 'analytics', 7.0),
    ('herald', 'market-research', 6.0),
    ('herald', 'react-nextjs', 1.0),
    ('herald', 'spark-databricks', 0.0),
    ('herald', 'terraform-iac', 0.0),
    ('herald', 'prd-writing', 3.0),
    ('herald', 'ui-wireframing', 2.0),
    ('herald', 'api-design', 0.0),
    ('herald', 'security-review', 0.0),
    ('herald', 'typescript', 1.0),
    ('herald', 'python', 1.0),
    ('herald', 'docker', 0.0),
    ('herald', 'testing', 1.0);
