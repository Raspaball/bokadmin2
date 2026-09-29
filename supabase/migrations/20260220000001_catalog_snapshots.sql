-- Shopify catalog snapshots: point-in-time copies of Shopify product catalog
CREATE TABLE shopify_catalog_snapshots (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  label text,
  product_count int NOT NULL DEFAULT 0,
  products jsonb NOT NULL DEFAULT '[]'
);

ALTER TABLE shopify_catalog_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_only" ON shopify_catalog_snapshots
  FOR ALL USING (auth.role() = 'authenticated');
