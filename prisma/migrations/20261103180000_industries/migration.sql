-- Industry master table. Workspaces point at it by id (organizations.industry_id) instead of
-- storing the display name, so names can change and only listed industries can be saved.
-- Rows are never deleted: set is_active = false to stop offering one.
CREATE TABLE industries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  slug varchar(60) NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name varchar(80) NOT NULL CHECK (btrim(name) <> ''),
  icon varchar(40) NOT NULL,
  featured boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  keywords text[] NOT NULL DEFAULT '{}',
  pipeline_template varchar(30),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT industries_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX industries_slug_key ON industries (slug);
-- "Pharma" and "pharma" are the same industry.
CREATE UNIQUE INDEX industries_name_lower_key ON industries (lower(name));
CREATE INDEX industries_is_active_sort_order_idx ON industries (is_active, sort_order);

INSERT INTO industries (slug, name, icon, featured, sort_order, keywords, pipeline_template) VALUES
  ('retail-distribution', 'Retail & distribution', 'Store', true, 10, ARRAY['retail', 'shop', 'store', 'distributor', 'dealer', 'stockist']::text[], 'retail'),
  ('manufacturing', 'Manufacturing', 'Factory', true, 20, ARRAY['factory', 'plant', 'OEM', 'industrial', 'MSME']::text[], 'manufacturing'),
  ('professional-services', 'Professional services', 'Briefcase', true, 30, ARRAY['agency', 'consultant', 'B2B services', 'freelance']::text[], 'services'),
  ('real-estate', 'Real estate', 'House', true, 40, ARRAY['property', 'broker', 'realtor', 'flats', 'plots']::text[], 'real_estate'),
  ('education', 'Education', 'GraduationCap', true, 50, ARRAY['institute', 'admissions', 'training', 'academy']::text[], 'education'),
  ('healthcare', 'Healthcare', 'HeartPulse', true, 60, ARRAY['medical', 'health', 'doctor', 'patient']::text[], 'healthcare'),
  ('wholesale-trading', 'Wholesale & trading', 'Boxes', false, 70, ARRAY['wholesaler', 'trader', 'B2B', 'bulk', 'supplier']::text[], 'retail'),
  ('e-commerce-d2c', 'E-commerce & D2C', 'ShoppingCart', false, 80, ARRAY['online store', 'marketplace', 'Shopify', 'Amazon seller', 'D2C']::text[], 'retail'),
  ('fmcg-consumer-goods', 'FMCG & consumer goods', 'ShoppingBasket', false, 90, ARRAY['FMCG', 'grocery', 'packaged food', 'personal care']::text[], 'retail'),
  ('automobile-dealerships', 'Automobile dealerships', 'Car', false, 100, ARRAY['car', 'bike', 'two-wheeler', 'showroom', 'EV dealer', 'auto']::text[], 'retail'),
  ('electronics-appliances', 'Electronics & appliances', 'Tv', false, 110, ARRAY['mobile shop', 'electrical', 'home appliances', 'gadgets']::text[], 'retail'),
  ('jewellery', 'Jewellery', 'Gem', false, 120, ARRAY['jeweller', 'gold', 'diamond', 'silver']::text[], 'retail'),
  ('furniture-home-decor', 'Furniture & home decor', 'Sofa', false, 130, ARRAY['furniture', 'interiors', 'modular kitchen', 'home furnishing']::text[], 'retail'),
  ('hardware-tools', 'Hardware & tools', 'Hammer', false, 140, ARRAY['hardware store', 'sanitaryware', 'paints', 'tools']::text[], 'retail'),
  ('restaurants-food', 'Restaurants & food', 'UtensilsCrossed', false, 150, ARRAY['restaurant', 'cafe', 'catering', 'cloud kitchen', 'bakery', 'QSR']::text[], 'retail'),
  ('agriculture-agritech', 'Agriculture & agritech', 'Sprout', false, 160, ARRAY['farm', 'seeds', 'fertiliser', 'agri inputs', 'dairy', 'FPO']::text[], 'retail'),
  ('textiles-apparel', 'Textiles & apparel', 'Shirt', false, 170, ARRAY['garments', 'fashion', 'clothing', 'fabric', 'yarn']::text[], 'manufacturing'),
  ('construction-contractors', 'Construction & contractors', 'HardHat', false, 180, ARRAY['builder', 'civil', 'contractor', 'infrastructure', 'EPC']::text[], 'manufacturing'),
  ('building-materials', 'Building materials', 'BrickWall', false, 190, ARRAY['cement', 'steel', 'tiles', 'ceramics', 'plywood', 'TMT']::text[], 'manufacturing'),
  ('chemicals-plastics', 'Chemicals & plastics', 'FlaskConical', false, 200, ARRAY['chemical', 'polymers', 'plastic', 'paints', 'specialty chemicals']::text[], 'manufacturing'),
  ('pharmaceuticals', 'Pharmaceuticals', 'Pill', false, 210, ARRAY['pharma', 'medicines', 'drugs', 'API', 'pharma distributor']::text[], 'manufacturing'),
  ('medical-devices-equipment', 'Medical devices & equipment', 'Stethoscope', false, 220, ARRAY['surgical', 'medical equipment', 'devices', 'lab equipment']::text[], 'manufacturing'),
  ('food-processing', 'Food processing', 'Wheat', false, 230, ARRAY['food manufacturing', 'spices', 'rice mill', 'snacks', 'beverages']::text[], 'manufacturing'),
  ('solar-renewable-energy', 'Solar & renewable energy', 'Sun', false, 240, ARRAY['solar', 'rooftop solar', 'EV charging', 'inverter', 'green energy']::text[], 'manufacturing'),
  ('printing-packaging', 'Printing & packaging', 'Printer', false, 250, ARRAY['printing press', 'packaging', 'labels', 'corrugated boxes']::text[], 'manufacturing'),
  ('import-export', 'Import & export', 'Ship', false, 260, ARRAY['exporter', 'importer', 'international trade', 'EXIM']::text[], 'manufacturing'),
  ('machinery-engineering', 'Machinery & engineering', 'Cog', false, 270, ARRAY['machines', 'engineering', 'fabrication', 'CNC', 'spare parts']::text[], 'manufacturing'),
  ('it-services-software', 'IT services & software', 'Code', false, 280, ARRAY['software', 'SaaS', 'IT', 'web development', 'app development', 'tech']::text[], 'services'),
  ('digital-marketing-advertising', 'Digital marketing & advertising', 'Megaphone', false, 290, ARRAY['agency', 'SEO', 'social media', 'ads', 'branding', 'PR']::text[], 'services'),
  ('consulting', 'Consulting', 'Lightbulb', false, 300, ARRAY['management consulting', 'advisory', 'business consultant']::text[], 'services'),
  ('legal-services', 'Legal services', 'Scale', false, 310, ARRAY['lawyer', 'advocate', 'law firm', 'legal']::text[], 'services'),
  ('accounting-tax', 'Accounting & tax', 'Calculator', false, 320, ARRAY['CA', 'chartered accountant', 'GST', 'bookkeeping', 'audit', 'tax filing']::text[], 'services'),
  ('staffing-recruitment', 'Staffing & recruitment', 'Users', false, 330, ARRAY['HR', 'placement', 'manpower', 'hiring', 'recruiter']::text[], 'services'),
  ('financial-services-loans', 'Financial services & loans', 'Banknote', false, 340, ARRAY['NBFC', 'loans', 'lending', 'DSA', 'mutual funds', 'wealth', 'fintech']::text[], 'services'),
  ('insurance', 'Insurance', 'ShieldCheck', false, 350, ARRAY['insurance agent', 'POSP', 'life insurance', 'health insurance', 'broker']::text[], 'services'),
  ('interior-design-architecture', 'Interior design & architecture', 'PencilRuler', false, 360, ARRAY['interior designer', 'architect', 'renovation', 'design studio']::text[], 'services'),
  ('travel-tourism', 'Travel & tourism', 'Plane', false, 370, ARRAY['travel agency', 'tour operator', 'holidays', 'visa', 'ticketing']::text[], 'services'),
  ('hotels-hospitality', 'Hotels & hospitality', 'Hotel', false, 380, ARRAY['hotel', 'resort', 'homestay', 'banquet']::text[], 'services'),
  ('events-weddings', 'Events & weddings', 'PartyPopper', false, 390, ARRAY['event management', 'wedding planner', 'decor', 'venue']::text[], 'services'),
  ('logistics-transport', 'Logistics & transport', 'Truck', false, 400, ARRAY['courier', 'freight', 'transporter', 'fleet', 'warehousing', '3PL']::text[], 'services'),
  ('telecom-internet', 'Telecom & internet', 'Wifi', false, 410, ARRAY['ISP', 'broadband', 'telecom', 'networking']::text[], 'services'),
  ('media-entertainment', 'Media & entertainment', 'Clapperboard', false, 420, ARRAY['production house', 'film', 'studio', 'content', 'OTT']::text[], 'services'),
  ('repair-home-services', 'Repair & home services', 'Wrench', false, 430, ARRAY['AC repair', 'maintenance', 'plumbing', 'electrician', 'pest control']::text[], 'services'),
  ('cleaning-facility-management', 'Cleaning & facility management', 'Sparkles', false, 440, ARRAY['housekeeping', 'facility management', 'security guards', 'cleaning']::text[], 'services'),
  ('photography-creative', 'Photography & creative', 'Camera', false, 450, ARRAY['photographer', 'videography', 'design', 'creative studio']::text[], 'services'),
  ('builders-developers', 'Builders & developers', 'Building2', false, 460, ARRAY['real estate developer', 'housing project', 'township', 'builder']::text[], 'real_estate'),
  ('rentals-co-living', 'Rentals & co-living', 'Building', false, 470, ARRAY['PG', 'hostel', 'co-working', 'rental', 'co-living', 'property management']::text[], 'real_estate'),
  ('schools-colleges', 'Schools & colleges', 'School', false, 480, ARRAY['school', 'college', 'university', 'admissions']::text[], 'education'),
  ('coaching-test-prep', 'Coaching & test prep', 'BookOpen', false, 490, ARRAY['coaching centre', 'tuition', 'JEE', 'NEET', 'UPSC', 'IELTS']::text[], 'education'),
  ('edtech-online-courses', 'EdTech & online courses', 'MonitorPlay', false, 500, ARRAY['edtech', 'online courses', 'e-learning', 'upskilling']::text[], 'education'),
  ('study-abroad-immigration', 'Study abroad & immigration', 'Globe', false, 510, ARRAY['overseas education', 'student visa', 'immigration consultant']::text[], 'education'),
  ('clinics-hospitals', 'Clinics & hospitals', 'Hospital', false, 520, ARRAY['clinic', 'hospital', 'nursing home', 'dental', 'IVF', 'eye care']::text[], 'healthcare'),
  ('diagnostics-labs', 'Diagnostics & labs', 'Microscope', false, 530, ARRAY['pathology', 'diagnostic centre', 'lab', 'radiology']::text[], 'healthcare'),
  ('fitness-wellness', 'Fitness & wellness', 'Dumbbell', false, 540, ARRAY['gym', 'yoga', 'spa', 'wellness', 'nutrition']::text[], 'healthcare'),
  ('beauty-salons', 'Beauty & salons', 'Scissors', false, 550, ARRAY['salon', 'beauty parlour', 'skin clinic', 'cosmetics', 'makeup']::text[], NULL),
  ('pet-care', 'Pet care', 'PawPrint', false, 560, ARRAY['vet', 'pet shop', 'grooming', 'pet food']::text[], NULL),
  ('non-profit-ngo', 'Non-profit & NGO', 'HandHeart', false, 570, ARRAY['NGO', 'charity', 'trust', 'foundation', 'fundraising']::text[], NULL),
  ('government-public-sector', 'Government & public sector', 'Landmark', false, 580, ARRAY['government', 'PSU', 'public sector', 'municipal']::text[], NULL),
  ('other', 'Other', 'Shapes', true, 1000, ARRAY['general', 'something else', 'not listed']::text[], NULL);

-- Point workspaces at the industry they chose by name, then drop the name column.
ALTER TABLE organizations ADD COLUMN industry_id uuid;
UPDATE organizations o SET industry_id = i.id FROM industries i WHERE lower(i.name) = lower(btrim(o.industry));
ALTER TABLE organizations DROP COLUMN industry;
CREATE INDEX organizations_industry_id_idx ON organizations (industry_id);
ALTER TABLE organizations ADD CONSTRAINT organizations_industry_id_fkey FOREIGN KEY (industry_id) REFERENCES industries(id) ON DELETE RESTRICT ON UPDATE CASCADE;
