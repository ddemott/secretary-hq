-- A template business for EVERY business type offered at signup (Dale 2026-09-25:
-- "always have a template for each business type").
--
-- 20260925000100 seeded the first two by hand (Auto Shop, Salon). This file adds
-- the rest from researched data specs, one call per business type, through
-- seed_business_template() — the same rules as the originals:
--   * services with NO price, durations in 15-minute steps;
--   * 1–3 resources named the way the business type names them ("Van 1");
--   * exactly two placeholder staff in the type's own wording ("Plumber 1" does
--     everything, "Plumber 2" the everyday work) — who-does-what is derived:
--     a staff member is linked to every service whose skills they all hold;
--   * knowledge starters the AI will not read until the owner saves them (the
--     copy is un-embedded; see copy_business_template_to_tenant);
--   * never customers, calls, appointments or hours.
-- tests/integration/businessTemplates.realdb.test.ts fails CI if a business type
-- in business_templates has no template.
--
-- med-spa is REMOVED from signup here, not given a template: a medical spa
-- performs medical procedures under a physician and holds health information —
-- HIPAA territory, which the product permanently excludes (Dale 2026-09-25).

-- The maintenance FLAG is transaction-local (like 20260925000100), so it cannot
-- outlive this migration. The helper function created below does persist, but
-- it is revoked from PUBLIC and cannot write to a template without the flag.
SELECT set_config('app.template_maintenance', 'on', true);

DELETE FROM business_templates WHERE business_type = 'med-spa';

-- The personal-trainer starter consultation no longer mentions injuries: health
-- information is for the trainer to discuss in person, not for the phone line
-- (shared/starterServices.ts; 20260901100000 was regenerated to match, but
-- databases that already ran it need this update).
UPDATE business_templates SET
  example_services = '[{"name":"Personal training session","is_default":true},{"name":"Intro consultation","description":"Talk through goals and current fitness before recommending a training plan.","look_first":true}]'::jsonb
 WHERE business_type = 'personal-trainer';

CREATE OR REPLACE FUNCTION seed_business_template(
  p_tenant_id uuid, p_name text, p_business_type text, p_vertical text, p_spec jsonb
) RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_item jsonb;
  v_res_ids jsonb := '{}'::jsonb;
  v_emp jsonb := '[]'::jsonb;
  v_id uuid;
  v_emp_item jsonb;
BEGIN
  INSERT INTO tenants (tenant_id, name, business_type, timezone, is_template, template_vertical)
  VALUES (p_tenant_id, p_name, p_business_type, 'America/Chicago', true, p_vertical)
  ON CONFLICT (tenant_id) DO NOTHING;

  -- Already built (re-run from seed.sql): leave it exactly as it is.
  IF EXISTS (SELECT 1 FROM services WHERE tenant_id = p_tenant_id) THEN
    RETURN;
  END IF;

  -- The tenants-insert trigger's generic resource; the spec brings its own.
  DELETE FROM resources WHERE tenant_id = p_tenant_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_spec->'skills') LOOP
    INSERT INTO tenant_skills (tenant_id, name, description)
    VALUES (p_tenant_id, v_item->>'name', v_item->>'description')
    ON CONFLICT DO NOTHING;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_spec->'resources') LOOP
    INSERT INTO resources (tenant_id, name, description)
    VALUES (p_tenant_id, v_item->>'name', v_item->>'description')
    RETURNING resource_id INTO v_id;
    v_res_ids := v_res_ids || jsonb_build_object(v_item->>'name', v_id);
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_spec->'staff') LOOP
    INSERT INTO employees (tenant_id, name, first_name, last_name, skills, is_active)
    VALUES (
      p_tenant_id,
      v_item->>'name',
      regexp_replace(v_item->>'name', '\s+\S+$', ''),
      regexp_replace(v_item->>'name', '^.*\s', ''),
      ARRAY(SELECT jsonb_array_elements_text(v_item->'skills')),
      true
    )
    RETURNING employee_id INTO v_id;
    v_emp := v_emp || jsonb_build_array(jsonb_build_object('id', v_id, 'skills', v_item->'skills'));
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_spec->'services') LOOP
    INSERT INTO services (tenant_id, name, description, duration_minutes, price,
                          required_skills, required_resources)
    VALUES (
      p_tenant_id,
      v_item->>'name',
      v_item->>'description',
      (v_item->>'minutes')::int,
      NULL,
      ARRAY(SELECT jsonb_array_elements_text(v_item->'skills')),
      ARRAY(SELECT jsonb_array_elements_text(v_item->'resources'))
    )
    RETURNING service_id INTO v_id;

    -- Who: every placeholder holding all of the service's skills.
    FOR v_emp_item IN SELECT * FROM jsonb_array_elements(v_emp) LOOP
      IF (v_emp_item->'skills') @> (v_item->'skills') THEN
        INSERT INTO service_employee (tenant_id, service_id, employee_id)
        VALUES (p_tenant_id, v_id, (v_emp_item->>'id')::uuid);
      END IF;
    END LOOP;

    -- Where: the resources the spec names for it.
    INSERT INTO service_resource (tenant_id, service_id, resource_id)
    SELECT p_tenant_id, v_id, (v_res_ids->>r)::uuid
      FROM jsonb_array_elements_text(v_item->'resources') AS r
     WHERE v_res_ids ? r;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_spec->'docs') LOOP
    INSERT INTO tenant_docs (tenant_id, title, section, content, source)
    VALUES (p_tenant_id, v_item->>'title', v_item->>'section', v_item->>'content', 'template');
  END LOOP;
END;
$$;

-- A migration-only builder: nobody else should be able to call it.
REVOKE ALL ON FUNCTION seed_business_template(uuid, text, text, text, jsonb) FROM PUBLIC;

-- ── Templates ────────────────────────────────────────────────────────────────
-- GENERATED BLOCK: one call per business type (research sources noted in the
-- PR). Do not hand-edit an existing template's rows — templates are read-only;
-- add a new migration instead.

-- ── Fix the first two templates' default service names ───────────────────────
-- The fallback service a call books when nothing else matches is picked by the
-- business type's starter default NAME (defaultServicePolicy): auto-shop
-- "Diagnostic visit", salon "Haircut". 20260925000100 named them differently,
-- so no default was set and an unmatched "my car is making a noise" booked a Tire
-- Rotation; "a haircut" matched the 30-minute men's cut. Renamed here, under the
-- maintenance flag, so every template carries its type's default by name
-- (tests/integration/businessTemplates.realdb.test.ts enforces it).
UPDATE services SET name = 'Diagnostic visit',
       description = 'Find the cause of a noise, warning light or other problem'
 WHERE tenant_id = '7e3a0000-0000-4000-8000-00000000a001'
   AND name = 'Check Engine Light Diagnostic';
-- ...and the default must be takeable by BOTH placeholders: Mechanic 2 could
-- not diagnose, so half the shop could never take the most common call.
UPDATE employees SET skills = array_append(skills, 'Diagnostics')
 WHERE tenant_id = '7e3a0000-0000-4000-8000-00000000a001'
   AND name = 'Mechanic 2' AND NOT ('Diagnostics' = ANY (skills));
INSERT INTO service_employee (tenant_id, service_id, employee_id)
SELECT s.tenant_id, s.service_id, e.employee_id
  FROM services s JOIN employees e ON e.tenant_id = s.tenant_id
 WHERE s.tenant_id = '7e3a0000-0000-4000-8000-00000000a001'
   AND s.name = 'Diagnostic visit' AND e.name = 'Mechanic 2'
ON CONFLICT DO NOTHING;
UPDATE services SET name = 'Haircut', description = 'Cut and style'
 WHERE tenant_id = '7e3a0000-0000-4000-8000-00000000a002'
   AND name = 'Women''s Haircut';

-- Answering & Scheduling Service Template (answering-service → owner_for_hire)
-- Research sources:
--   https://www.freelancerfaqs.com/plan-effective-discovery-call/
--   https://schedulingkit.com/booking-page/consultants
--   https://dev.to/ching_leo_9deee65f1d55e77/free-30-minute-discovery-call-script-for-us-freelancers-agenda-7-questions-walk-away-flags-eo7
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a003', 'Answering & Scheduling Service Template', 'answering-service', 'owner_for_hire',
  $spec${
  "skills": [
    {
      "name": "Discovery calls",
      "description": "Short first conversations to learn what a caller needs."
    },
    {
      "name": "Client meetings",
      "description": "Longer working sessions with new or current clients."
    },
    {
      "name": "Scheduling",
      "description": "Booking and managing the calendar."
    }
  ],
  "resources": [
    {
      "name": "Main Office",
      "description": "The main place meetings happen, in person or by video."
    },
    {
      "name": "Phone Line 1",
      "description": "The phone or video line used for calls."
    },
    {
      "name": "Phone Line 2",
      "description": "The phone or video line used for calls."
    }
  ],
  "staff": [
    {
      "name": "Staff 1",
      "skills": [
        "Discovery calls",
        "Client meetings",
        "Scheduling"
      ]
    },
    {
      "name": "Staff 2",
      "skills": [
        "Discovery calls",
        "Scheduling"
      ]
    }
  ],
  "services": [
    {
      "name": "Intro call",
      "description": "A quick first call to see whether we are a good fit.",
      "minutes": 15,
      "skills": [
        "Discovery calls"
      ],
      "resources": [
        "Phone Line 1",
        "Phone Line 2"
      ]
    },
    {
      "name": "Phone consultation",
      "description": "A phone call to talk through what you need and next steps.",
      "minutes": 30,
      "skills": [
        "Discovery calls"
      ],
      "resources": [
        "Main Office",
        "Phone Line 1",
        "Phone Line 2"
      ]
    },
    {
      "name": "Meeting",
      "description": "A sit-down meeting, in person or by video.",
      "minutes": 60,
      "skills": [
        "Client meetings"
      ],
      "resources": [
        "Main Office",
        "Phone Line 1",
        "Phone Line 2"
      ]
    },
    {
      "name": "Project check-in",
      "description": "A short follow-up call with a current client.",
      "minutes": 30,
      "skills": [
        "Client meetings"
      ],
      "resources": [
        "Phone Line 1",
        "Phone Line 2"
      ]
    },
    {
      "name": "Working session",
      "description": "A longer session to dig into a project in detail.",
      "minutes": 90,
      "skills": [
        "Client meetings"
      ],
      "resources": [
        "Main Office"
      ]
    }
  ],
  "docs": [
    {
      "title": "How do I set up a time to talk?",
      "section": "Booking",
      "content": "We can book a phone consultation or meeting for you right on this call."
    },
    {
      "title": "Can we meet by video instead of in person?",
      "section": "Visit",
      "content": "Many of our meetings happen by phone or video. Let us know which you prefer when you book."
    },
    {
      "title": "What should I have ready for the first call?",
      "section": "Service",
      "content": "A short description of what you need and any timeline you have in mind helps us make the most of the time."
    },
    {
      "title": "Can I leave a message instead?",
      "section": "Policies",
      "content": "Yes. We can take a message with your name, number, and what it is about, and pass it along."
    }
  ]
}$spec$::jsonb
);

-- Bakery Template (bakery → bakery)
-- Research sources:
--   https://www.gateaubakery.com/tasting-appointments
--   https://orlandparkbakery.com/wedding-cakes/tasting/
--   https://www.freedombakery.com/pages/schedule-a-tasting-consultation
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a004', 'Bakery Template', 'bakery', 'bakery',
  $spec${
  "skills": [
    {
      "name": "Custom cakes",
      "description": "Designing and decorating custom cakes."
    },
    {
      "name": "Order taking",
      "description": "Taking and scheduling orders."
    },
    {
      "name": "Tastings",
      "description": "Hosting flavor tastings."
    }
  ],
  "resources": [
    {
      "name": "Counter 1",
      "description": "Front counter for pickups and quick visits."
    },
    {
      "name": "Tasting Table",
      "description": "Seated table for tastings and consults."
    }
  ],
  "staff": [
    {
      "name": "Baker 1",
      "skills": [
        "Custom cakes",
        "Order taking",
        "Tastings"
      ]
    },
    {
      "name": "Baker 2",
      "skills": [
        "Order taking",
        "Tastings",
        "Custom cakes"
      ]
    }
  ],
  "services": [
    {
      "name": "Custom order consult",
      "description": "Talk through the design, size, and date for a custom order.",
      "minutes": 30,
      "skills": [
        "Custom cakes"
      ],
      "resources": [
        "Tasting Table",
        "Counter 1"
      ]
    },
    {
      "name": "Cake tasting",
      "description": "Sample flavors and fillings.",
      "minutes": 45,
      "skills": [
        "Tastings"
      ],
      "resources": [
        "Tasting Table"
      ]
    },
    {
      "name": "Wedding cake consult",
      "description": "Plan a wedding cake with a baker, with tasting.",
      "minutes": 60,
      "skills": [
        "Custom cakes",
        "Tastings"
      ],
      "resources": [
        "Tasting Table"
      ]
    },
    {
      "name": "Order pickup",
      "description": "Pick up a finished order.",
      "minutes": 15,
      "skills": [
        "Order taking"
      ],
      "resources": [
        "Counter 1"
      ]
    },
    {
      "name": "Large order planning",
      "description": "Plan a bulk order for an office, party, or event.",
      "minutes": 30,
      "skills": [
        "Order taking"
      ],
      "resources": [
        "Counter 1",
        "Tasting Table"
      ]
    }
  ],
  "docs": [
    {
      "title": "How far ahead should I order a custom cake?",
      "section": "Booking",
      "content": "The earlier the better, especially for weddings and busy seasons. We'll check the calendar for your date when you book a consult."
    },
    {
      "title": "What should I bring to a consult?",
      "section": "Visit",
      "content": "Bring your date, number of guests, and any photos or ideas you like."
    },
    {
      "title": "Can you work with allergies?",
      "section": "Policies",
      "content": "Please tell us about any allergies when you book. Our kitchen handles common allergens, so we'll talk through what we can do."
    },
    {
      "title": "Can someone else pick up my order?",
      "section": "Service",
      "content": "Yes. Just give us their name when you order."
    }
  ]
}$spec$::jsonb
);

-- Barbershop Template (barbershop → barbershop)
-- Research sources:
--   https://www.mangomint.com/blog/barbershop-menu-ideas/
--   https://www.manhattanbarbershopny.com/post/your-first-visit-to-a-new-barbershop-what-to-expect
--   https://buybarber.com/blogs/news/how-long-does-it-take-a-barber-to-cut-hair
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a005', 'Barbershop Template', 'barbershop', 'barbershop',
  $spec${
  "skills": [
    {
      "name": "Haircuts",
      "description": "Clipper and scissor cuts, fades and tapers."
    },
    {
      "name": "Beard trimming",
      "description": "Shaping, lining and trimming beards."
    },
    {
      "name": "Straight razor shaving",
      "description": "Hot towel and straight razor shaves."
    }
  ],
  "resources": [
    {
      "name": "Chair 1",
      "description": "A barber chair."
    },
    {
      "name": "Chair 2",
      "description": "A barber chair."
    },
    {
      "name": "Chair 3",
      "description": "A barber chair."
    }
  ],
  "staff": [
    {
      "name": "Barber 1",
      "skills": [
        "Haircuts",
        "Beard trimming",
        "Straight razor shaving"
      ]
    },
    {
      "name": "Barber 2",
      "skills": [
        "Haircuts",
        "Beard trimming"
      ]
    }
  ],
  "services": [
    {
      "name": "Haircut",
      "description": "A standard cut, including a neck clean-up and styling.",
      "minutes": 30,
      "skills": [
        "Haircuts"
      ],
      "resources": [
        "Chair 1",
        "Chair 2",
        "Chair 3"
      ]
    },
    {
      "name": "Beard trim",
      "description": "Shape, trim and line up the beard.",
      "minutes": 15,
      "skills": [
        "Beard trimming"
      ],
      "resources": [
        "Chair 1",
        "Chair 2",
        "Chair 3"
      ]
    },
    {
      "name": "Haircut & beard",
      "description": "A haircut and a beard trim in one visit.",
      "minutes": 45,
      "skills": [
        "Haircuts",
        "Beard trimming"
      ],
      "resources": [
        "Chair 1",
        "Chair 2",
        "Chair 3"
      ]
    },
    {
      "name": "Kids haircut",
      "description": "A haircut for younger customers.",
      "minutes": 30,
      "skills": [
        "Haircuts"
      ],
      "resources": [
        "Chair 1",
        "Chair 2",
        "Chair 3"
      ]
    },
    {
      "name": "Line-up",
      "description": "A quick clean-up of the hairline and edges between cuts.",
      "minutes": 15,
      "skills": [
        "Haircuts"
      ],
      "resources": [
        "Chair 1",
        "Chair 2",
        "Chair 3"
      ]
    },
    {
      "name": "Hot towel shave",
      "description": "A traditional straight razor shave with hot towels.",
      "minutes": 30,
      "skills": [
        "Straight razor shaving"
      ],
      "resources": [
        "Chair 1",
        "Chair 2",
        "Chair 3"
      ]
    }
  ],
  "docs": [
    {
      "title": "Do you take walk-ins?",
      "section": "Booking",
      "content": "We welcome walk-ins when a chair is free, but booking an appointment is the best way to make sure we can see you when you want."
    },
    {
      "title": "Can I ask for a specific barber?",
      "section": "Booking",
      "content": "Yes. Let us know who you would like when you book and we will schedule you with them if they are available."
    },
    {
      "title": "What if I'm running late?",
      "section": "Policies",
      "content": "Please let us know as soon as you can. If you are very late we may need to shorten the service or move you to the next open time."
    },
    {
      "title": "Should I bring a photo of the cut I want?",
      "section": "Visit",
      "content": "Yes, a photo helps. Your barber will talk through the style with you before starting."
    }
  ]
}$spec$::jsonb
);

-- Body & Paint Shop Template (body-shop → body_shop)
-- Research sources:
--   https://elisautobody.com/how-long-does-an-estimate-take/
--   https://www.byerscollision.com/collision-center-research/body-shop-estimate-times/
--   https://www.primetimepdr.com/how-long-paintless-dent-repair-take/
--   https://nortonsbodyshop.com/blog/how-long-do-auto-body-repairs-really-take/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a006', 'Body & Paint Shop Template', 'body-shop', 'body_shop',
  $spec${
  "skills": [
    {
      "name": "Estimating",
      "description": "Inspecting damage and writing up the repair plan."
    },
    {
      "name": "Dent Repair",
      "description": "Pulling and smoothing dents, including paintless dent repair."
    },
    {
      "name": "Polishing",
      "description": "Buffing out light scratches and scuffs."
    },
    {
      "name": "Painting",
      "description": "Color matching, prep and paint work in the booth."
    },
    {
      "name": "Panel Repair",
      "description": "Repairing or replacing bumpers and body panels."
    }
  ],
  "resources": [
    {
      "name": "Repair Booth 1",
      "description": "Work area for estimates, dent work and prep."
    },
    {
      "name": "Paint Booth 1",
      "description": "Enclosed booth for paint and refinishing work."
    }
  ],
  "staff": [
    {
      "name": "Body Tech 1",
      "skills": [
        "Estimating",
        "Dent Repair",
        "Polishing",
        "Painting",
        "Panel Repair"
      ]
    },
    {
      "name": "Body Tech 2",
      "skills": [
        "Estimating",
        "Dent Repair",
        "Polishing"
      ]
    }
  ],
  "services": [
    {
      "name": "Damage estimate",
      "description": "We look over the damage and write up what the repair needs.",
      "minutes": 30,
      "skills": [
        "Estimating"
      ],
      "resources": [
        "Repair Booth 1"
      ]
    },
    {
      "name": "Dent repair",
      "description": "Small dents and door dings, often fixed without repainting.",
      "minutes": 90,
      "skills": [
        "Dent Repair"
      ],
      "resources": [
        "Repair Booth 1"
      ]
    },
    {
      "name": "Scratch buff-out",
      "description": "Buffing out light scratches and scuffs that have not gone through the paint.",
      "minutes": 60,
      "skills": [
        "Polishing"
      ],
      "resources": [
        "Repair Booth 1"
      ]
    },
    {
      "name": "Paint touch-up",
      "description": "Color-matched paint repair on chips and small damaged areas.",
      "minutes": 120,
      "skills": [
        "Painting"
      ],
      "resources": [
        "Paint Booth 1"
      ]
    },
    {
      "name": "Bumper repair",
      "description": "Repairing a cracked or dented bumper and refinishing it to match.",
      "minutes": 240,
      "skills": [
        "Panel Repair",
        "Painting"
      ],
      "resources": [
        "Paint Booth 1"
      ]
    }
  ],
  "docs": [
    {
      "title": "Do I need an appointment for an estimate?",
      "section": "Booking",
      "content": "Booking an estimate saves you a wait. A look at minor damage is usually quick; bigger damage can take longer to inspect."
    },
    {
      "title": "Do you work with insurance companies?",
      "section": "Policies",
      "content": "We work with most insurance companies. If you have a claim number, bring it with you to the estimate."
    },
    {
      "title": "How long will my repair take?",
      "section": "Service",
      "content": "It depends on the damage and whether parts need to be ordered. We'll give you a time estimate once we've looked at the car."
    },
    {
      "title": "What should I bring to my estimate?",
      "section": "Visit",
      "content": "We ask you to bring the vehicle, your insurance information if you're filing a claim, and any photos or paperwork from the incident."
    }
  ]
}$spec$::jsonb
);

-- Car Detailing Template (car-detailing → car_detailing)
-- Research sources:
--   https://www.autotrader.com/car-shopping/how-long-detail-car
--   https://autospa360.com/how-long-does-auto-detailing-take-a-complete-breakdown/
--   https://detailtheworld.com/blogs/news/how-long-does-it-take-to-detail-the-inside-of-a-car
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a007', 'Car Detailing Template', 'car-detailing', 'car_detailing',
  $spec${
  "skills": [
    {
      "name": "Interior Detailing",
      "description": "Vacuuming, shampooing, and cleaning seats, carpets and surfaces."
    },
    {
      "name": "Exterior Detailing",
      "description": "Hand washing, decontaminating and waxing the paint."
    },
    {
      "name": "Paint Correction",
      "description": "Machine polishing to remove swirls and light scratches."
    }
  ],
  "resources": [
    {
      "name": "Detail Bay 1",
      "description": "Covered bay for detail work."
    },
    {
      "name": "Detail Bay 2",
      "description": "Second covered bay for detail work."
    }
  ],
  "staff": [
    {
      "name": "Detailer 1",
      "skills": [
        "Interior Detailing",
        "Exterior Detailing",
        "Paint Correction"
      ]
    },
    {
      "name": "Detailer 2",
      "skills": [
        "Interior Detailing",
        "Exterior Detailing"
      ]
    }
  ],
  "services": [
    {
      "name": "Detail consultation",
      "description": "We look over your vehicle and recommend the right package.",
      "minutes": 30,
      "skills": [
        "Exterior Detailing"
      ],
      "resources": [
        "Detail Bay 1",
        "Detail Bay 2"
      ]
    },
    {
      "name": "Express interior clean",
      "description": "Quick vacuum, wipe-down of surfaces and windows inside.",
      "minutes": 60,
      "skills": [
        "Interior Detailing"
      ],
      "resources": [
        "Detail Bay 1",
        "Detail Bay 2"
      ]
    },
    {
      "name": "Full interior detail",
      "description": "Deep clean of seats, carpets, vents and surfaces, including stain treatment.",
      "minutes": 180,
      "skills": [
        "Interior Detailing"
      ],
      "resources": [
        "Detail Bay 1",
        "Detail Bay 2"
      ]
    },
    {
      "name": "Exterior wash and wax",
      "description": "Hand wash, wheels and tires, and a coat of wax.",
      "minutes": 120,
      "skills": [
        "Exterior Detailing"
      ],
      "resources": [
        "Detail Bay 1",
        "Detail Bay 2"
      ]
    },
    {
      "name": "Full detail",
      "description": "Complete interior and exterior detail.",
      "minutes": 300,
      "skills": [
        "Interior Detailing",
        "Exterior Detailing"
      ],
      "resources": [
        "Detail Bay 1",
        "Detail Bay 2"
      ]
    },
    {
      "name": "Paint correction",
      "description": "Machine polishing to reduce swirl marks and light scratches.",
      "minutes": 360,
      "skills": [
        "Paint Correction",
        "Exterior Detailing"
      ],
      "resources": [
        "Detail Bay 1"
      ]
    }
  ],
  "docs": [
    {
      "title": "How long will my detail take?",
      "section": "Service",
      "content": "It depends on the package, the size of the vehicle and its condition. We'll give you a time when you book."
    },
    {
      "title": "Should I empty my car before the appointment?",
      "section": "Visit",
      "content": "Yes, please take out personal items and valuables so we can clean every area."
    },
    {
      "title": "Can you get out pet hair and stains?",
      "section": "Service",
      "content": "We treat pet hair and most common stains. Some older or set-in stains may not come out completely."
    },
    {
      "title": "What if I need to reschedule?",
      "section": "Policies",
      "content": "Just call us as soon as you know and we'll find you a new time."
    }
  ]
}$spec$::jsonb
);

-- Car Wash Template (car-wash → car_wash)
-- Research sources:
--   https://carxplorer.com/how-long-does-a-car-wash-take/
--   https://gleamautospa.net/services/exterior-detailing/hand-wash-wax/
--   https://yourautospace.com/how-long-is-a-car-wash/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a008', 'Car Wash Template', 'car-wash', 'car_wash',
  $spec${
  "skills": [
    {
      "name": "Washing",
      "description": "Exterior wash, wheels and drying."
    },
    {
      "name": "Waxing",
      "description": "Applying hand wax or sealant."
    },
    {
      "name": "Interior Cleaning",
      "description": "Vacuuming and wiping down the inside."
    }
  ],
  "resources": [
    {
      "name": "Wash Bay 1",
      "description": "Wash bay."
    },
    {
      "name": "Wash Bay 2",
      "description": "Second wash bay."
    }
  ],
  "staff": [
    {
      "name": "Washer 1",
      "skills": [
        "Washing",
        "Waxing",
        "Interior Cleaning"
      ]
    },
    {
      "name": "Washer 2",
      "skills": [
        "Washing",
        "Interior Cleaning"
      ]
    }
  ],
  "services": [
    {
      "name": "Express wash",
      "description": "Quick exterior wash and dry.",
      "minutes": 15,
      "skills": [
        "Washing"
      ],
      "resources": [
        "Wash Bay 1",
        "Wash Bay 2"
      ]
    },
    {
      "name": "Hand wash",
      "description": "Full exterior hand wash, wheels, tires and hand dry.",
      "minutes": 45,
      "skills": [
        "Washing"
      ],
      "resources": [
        "Wash Bay 1",
        "Wash Bay 2"
      ]
    },
    {
      "name": "Interior vacuum and wipe-down",
      "description": "Vacuum, wipe down dash and door panels, and clean inside windows.",
      "minutes": 30,
      "skills": [
        "Interior Cleaning"
      ],
      "resources": [
        "Wash Bay 1",
        "Wash Bay 2"
      ]
    },
    {
      "name": "Wash and interior combo",
      "description": "Hand wash outside plus a vacuum and wipe-down inside.",
      "minutes": 60,
      "skills": [
        "Washing",
        "Interior Cleaning"
      ],
      "resources": [
        "Wash Bay 1",
        "Wash Bay 2"
      ]
    },
    {
      "name": "Hand wash and wax",
      "description": "Hand wash followed by a coat of hand-applied wax.",
      "minutes": 90,
      "skills": [
        "Washing",
        "Waxing"
      ],
      "resources": [
        "Wash Bay 1",
        "Wash Bay 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "Do I need an appointment?",
      "section": "Booking",
      "content": "Booking ahead holds a bay for you. We also take drive-ups when a bay is open."
    },
    {
      "title": "Do you wash trucks and SUVs?",
      "section": "Service",
      "content": "Yes. Larger vehicles can take a little longer, so let us know what you drive when you book."
    },
    {
      "title": "Is a hand wash safe for my paint?",
      "section": "Service",
      "content": "Yes, we wash by hand with care. Let us know about any loose trim, fresh paint or aftermarket parts before we start."
    },
    {
      "title": "Can I wait while you wash my car?",
      "section": "Visit",
      "content": "Yes, we finish most washes while you wait."
    }
  ]
}$spec$::jsonb
);

-- Catering Service Template (catering → catering)
-- Research sources:
--   https://crazydutchmancatering.com/catering-tastings-what-to-expect-and-how-to-prepare/
--   https://dreameventsandcatering.com/dream-tips-all-your-wedding-tasting-questions-answered/
--   https://www.katiescateringkc.com/catering-questions-and-answers-faqs/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a009', 'Catering Service Template', 'catering', 'catering',
  $spec${
  "skills": [
    {
      "name": "Event planning",
      "description": "Planning menus and service for events."
    },
    {
      "name": "Menu tastings",
      "description": "Hosting tastings of menu options."
    },
    {
      "name": "Site visits",
      "description": "Visiting event locations."
    }
  ],
  "resources": [
    {
      "name": "Kitchen 1",
      "description": "Main kitchen and tasting area."
    },
    {
      "name": "Meeting Room",
      "description": "Space for consults."
    },
    {
      "name": "On Location 1",
      "description": "Visits to the event location."
    },
    {
      "name": "On Location 2",
      "description": "Visits to the event location."
    }
  ],
  "staff": [
    {
      "name": "Chef 1",
      "skills": [
        "Event planning",
        "Menu tastings",
        "Site visits"
      ]
    },
    {
      "name": "Chef 2",
      "skills": [
        "Event planning",
        "Menu tastings"
      ]
    }
  ],
  "services": [
    {
      "name": "Discovery call",
      "description": "A quick call about your date, headcount, and style of event.",
      "minutes": 15,
      "skills": [
        "Event planning"
      ],
      "resources": [
        "Meeting Room"
      ]
    },
    {
      "name": "Event consult",
      "description": "Plan the menu and service for your event.",
      "minutes": 60,
      "skills": [
        "Event planning"
      ],
      "resources": [
        "Meeting Room",
        "Kitchen 1"
      ]
    },
    {
      "name": "Tasting",
      "description": "Sample dishes being considered for your menu.",
      "minutes": 90,
      "skills": [
        "Menu tastings"
      ],
      "resources": [
        "Kitchen 1"
      ]
    },
    {
      "name": "Site visit",
      "description": "Walk through your event location with a chef.",
      "minutes": 60,
      "skills": [
        "Site visits"
      ],
      "resources": [
        "On Location 1",
        "On Location 2"
      ]
    },
    {
      "name": "Final details meeting",
      "description": "Confirm the menu, headcount, and timeline before the event.",
      "minutes": 45,
      "skills": [
        "Event planning"
      ],
      "resources": [
        "Meeting Room"
      ]
    }
  ],
  "docs": [
    {
      "title": "What should I know before I call?",
      "section": "Booking",
      "content": "Your date, rough guest count, location, and the kind of event are a great start. We can fill in the rest together."
    },
    {
      "title": "How far ahead should I book?",
      "section": "Booking",
      "content": "The earlier the better, especially for weddings and busy seasons. We'll check the calendar for your date."
    },
    {
      "title": "Can you handle dietary needs?",
      "section": "Service",
      "content": "Please tell us about allergies and dietary needs early, and we'll talk through menu options with you."
    },
    {
      "title": "Who comes to a tasting?",
      "section": "Visit",
      "content": "Bring the people who help make decisions about the menu. Let us know how many when you book."
    }
  ]
}$spec$::jsonb
);

-- Cleaning Service Template (cleaning → cleaning)
-- Research sources:
--   https://www.bestmaids.com/blog/how-long-does-house-cleaning-take/
--   https://greenmaidscleaning.com/how-long-does-a-deep-cleaning-service-take-understanding-the-average-time-required-for-your-home/
--   https://www.burrinicleaning.com/post/move-out-cleaning-time-estimate-how-long-does-it-take
--   https://www.purehousecleaning.com/blog/scheduling-house-cleanings-how-long-does-it-take-to-clean-a-home/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a010', 'Cleaning Service Template', 'cleaning', 'cleaning',
  $spec${
  "skills": [
    {
      "name": "Standard cleaning",
      "description": "Regular top-to-bottom cleaning of a lived-in home"
    },
    {
      "name": "Deep cleaning",
      "description": "Detailed cleaning of baseboards, inside appliances and built-up grime"
    },
    {
      "name": "Move-in and move-out",
      "description": "Cleaning an empty home before or after a move"
    },
    {
      "name": "Estimates",
      "description": "Walking the home to plan the job"
    }
  ],
  "resources": [
    {
      "name": "Team A",
      "description": "Cleaning team with supplies and equipment"
    },
    {
      "name": "Team B",
      "description": "Second cleaning team"
    }
  ],
  "staff": [
    {
      "name": "Cleaner 1",
      "skills": [
        "Standard cleaning",
        "Deep cleaning",
        "Move-in and move-out",
        "Estimates"
      ]
    },
    {
      "name": "Cleaner 2",
      "skills": [
        "Standard cleaning",
        "Estimates"
      ]
    }
  ],
  "services": [
    {
      "name": "Walkthrough estimate",
      "description": "Short visit to see the home and plan the right cleaning",
      "minutes": 30,
      "skills": [
        "Estimates"
      ],
      "resources": [
        "Team A",
        "Team B"
      ]
    },
    {
      "name": "One-time clean",
      "description": "A single standard cleaning of the home",
      "minutes": 180,
      "skills": [
        "Standard cleaning"
      ],
      "resources": [
        "Team A",
        "Team B"
      ]
    },
    {
      "name": "Recurring clean",
      "description": "Regular weekly, every-other-week or monthly cleaning",
      "minutes": 120,
      "skills": [
        "Standard cleaning"
      ],
      "resources": [
        "Team A",
        "Team B"
      ]
    },
    {
      "name": "Deep clean",
      "description": "Detailed cleaning for a first visit or a home that needs extra attention",
      "minutes": 240,
      "skills": [
        "Deep cleaning"
      ],
      "resources": [
        "Team A",
        "Team B"
      ]
    },
    {
      "name": "Move-in or move-out clean",
      "description": "Full cleaning of an empty home before or after a move",
      "minutes": 300,
      "skills": [
        "Move-in and move-out"
      ],
      "resources": [
        "Team A",
        "Team B"
      ]
    }
  ],
  "docs": [
    {
      "title": "Do you bring your own supplies?",
      "section": "Service",
      "content": "Yes, we bring our own supplies and equipment. If you want us to use a certain product, just let us know."
    },
    {
      "title": "Do I need to be home?",
      "section": "Visit",
      "content": "No, many clients are not home. Please arrange how we get in directly with the owner rather than sharing door or lockbox codes over the phone."
    },
    {
      "title": "How long does a cleaning take?",
      "section": "Booking",
      "content": "It depends on the size of the home and the type of cleaning. A walkthrough helps us set aside the right amount of time."
    },
    {
      "title": "What should I do before the cleaners arrive?",
      "section": "Visit",
      "content": "Picking up clutter helps us spend our time cleaning, and please let us know about pets or rooms to skip."
    }
  ]
}$spec$::jsonb
);

-- Electrical Service Template (electrician → electrician)
-- Research sources:
--   https://www.abacusplumbing.com/electrician/resources/what-to-expect-during-an-electrical-service-call-a-step-by-step-guide-for-north-austin-homeowners/
--   https://toweryelectric.com/what-to-do-while-waiting-electrician/
--   https://www.instaelectricians.com/blog/when-to-call-electrician/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a011', 'Electrical Service Template', 'electrician', 'electrician',
  $spec${
  "skills": [
    {
      "name": "General electrical",
      "description": "Troubleshooting, outlets, switches and everyday repairs"
    },
    {
      "name": "Lighting",
      "description": "Light fixtures, ceiling fans and outdoor lighting"
    },
    {
      "name": "Panels and circuits",
      "description": "Breaker panels, new circuits and larger wiring work"
    }
  ],
  "resources": [
    {
      "name": "Van 1",
      "description": "Service van with tools and common parts"
    },
    {
      "name": "Van 2",
      "description": "Second service van"
    }
  ],
  "staff": [
    {
      "name": "Electrician 1",
      "skills": [
        "General electrical",
        "Lighting",
        "Panels and circuits"
      ]
    },
    {
      "name": "Electrician 2",
      "skills": [
        "General electrical",
        "Lighting"
      ]
    }
  ],
  "services": [
    {
      "name": "Service call",
      "description": "Visit to find and fix an electrical problem, like a dead outlet or a tripping breaker",
      "minutes": 120,
      "skills": [
        "General electrical"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Outlet or switch install",
      "description": "Add or replace outlets, switches or dimmers",
      "minutes": 60,
      "skills": [
        "General electrical"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Lighting install",
      "description": "Install or replace light fixtures, recessed lights or outdoor lights",
      "minutes": 90,
      "skills": [
        "Lighting"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Ceiling fan install",
      "description": "Install or replace a ceiling fan",
      "minutes": 90,
      "skills": [
        "Lighting"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Panel or new circuit estimate",
      "description": "Look at the panel and plan a new circuit, upgrade or larger job",
      "minutes": 60,
      "skills": [
        "Panels and circuits"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "What should I do if I see sparks, smoke or smell burning?",
      "section": "Service",
      "content": "If it is safe to do so, turn off power at the breaker and leave the area. If there is smoke or fire, get out and call 911 first."
    },
    {
      "title": "Do I need to be home for the visit?",
      "section": "Visit",
      "content": "Yes, we ask that an adult be home so we can get in, see the problem and go over the work with you."
    },
    {
      "title": "How do appointments work?",
      "section": "Booking",
      "content": "We book a time for an electrician to come out, and we set aside enough time to look at the problem and fix it when we can."
    },
    {
      "title": "What can I do to get ready?",
      "section": "Visit",
      "content": "Please clear space around the panel and the area we are working on, and keep pets in another room."
    }
  ]
}$spec$::jsonb
);

-- Garage Door Service Template (garage-door → garage_door)
-- Research sources:
--   https://www.joesdoors.com/resources/blog/how-long-does-it-take-to-replace-or-repair-a-garage-door/
--   https://herogaragedoor.com/replace-garage-door-springs-time/
--   https://alliantgaragedoor.com/how-long-does-garage-door-repair-take-what-to-expect-from-start-to-finish/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a012', 'Garage Door Service Template', 'garage-door', 'garage_door',
  $spec${
  "skills": [
    {
      "name": "Door Repair",
      "description": "Diagnosing problems, adjusting, lubricating and replacing rollers and hardware."
    },
    {
      "name": "Springs and Cables",
      "description": "Replacing springs and cables under tension."
    },
    {
      "name": "Openers",
      "description": "Installing and repairing garage door openers and sensors."
    }
  ],
  "resources": [
    {
      "name": "Van 1",
      "description": "Service van with parts and tools."
    },
    {
      "name": "Van 2",
      "description": "Second service van."
    }
  ],
  "staff": [
    {
      "name": "Installer 1",
      "skills": [
        "Door Repair",
        "Springs and Cables",
        "Openers"
      ]
    },
    {
      "name": "Installer 2",
      "skills": [
        "Door Repair",
        "Openers"
      ]
    }
  ],
  "services": [
    {
      "name": "Service call",
      "description": "We come out, find the problem and fix what we can on the spot.",
      "minutes": 60,
      "skills": [
        "Door Repair"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Tune-up",
      "description": "Lubricating, adjusting and checking the door's balance and safety features.",
      "minutes": 60,
      "skills": [
        "Door Repair"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Spring replacement",
      "description": "Replacing broken or worn garage door springs.",
      "minutes": 90,
      "skills": [
        "Springs and Cables"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Off-track door repair",
      "description": "Getting a door back on its tracks and replacing damaged parts.",
      "minutes": 90,
      "skills": [
        "Door Repair",
        "Springs and Cables"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Opener repair",
      "description": "Fixing an opener, remote or safety sensors that aren't working right.",
      "minutes": 60,
      "skills": [
        "Openers"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Opener install",
      "description": "Installing a new garage door opener, including sensors and remotes.",
      "minutes": 180,
      "skills": [
        "Openers"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "My spring broke. Can I still open the door?",
      "section": "Service",
      "content": "Please don't try to force the door open or fix the spring yourself. Leave it closed and we can book a technician to look at it."
    },
    {
      "title": "Do you work on all brands?",
      "section": "Service",
      "content": "We work on most common brands of garage doors and openers. Tell us what you have when you book."
    },
    {
      "title": "Does someone need to be home?",
      "section": "Visit",
      "content": "Yes, please have someone there to let us into the garage and go over the work with us."
    },
    {
      "title": "How long will the repair take?",
      "section": "Booking",
      "content": "Most repairs are done in one visit. Bigger jobs like a new opener take longer, and we'll give you a time when you book."
    }
  ]
}$spec$::jsonb
);

-- HVAC Service Template (hvac → hvac)
-- Research sources:
--   https://www.hvac.com/expert-advice/how-long-does-an-ac-tune-up-take/
--   https://www.bryant.com/en/us/products/hvac-tune-up/
--   https://www.covenantairesolutions.com/post/how-long-does-hvac-maintenance-take
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a013', 'HVAC Service Template', 'hvac', 'hvac',
  $spec${
  "skills": [
    {
      "name": "Diagnostics and repair",
      "description": "Finding and fixing heating and cooling problems"
    },
    {
      "name": "Maintenance",
      "description": "Seasonal tune-ups and cleaning"
    },
    {
      "name": "Thermostats",
      "description": "Installing and setting up thermostats"
    },
    {
      "name": "System estimates",
      "description": "Sizing and quoting new or replacement systems"
    }
  ],
  "resources": [
    {
      "name": "Van 1",
      "description": "Service van with tools and common parts"
    },
    {
      "name": "Van 2",
      "description": "Second service van"
    }
  ],
  "staff": [
    {
      "name": "Technician 1",
      "skills": [
        "Diagnostics and repair",
        "Maintenance",
        "Thermostats",
        "System estimates"
      ]
    },
    {
      "name": "Technician 2",
      "skills": [
        "Maintenance",
        "Thermostats",
        "Diagnostics and repair"
      ]
    }
  ],
  "services": [
    {
      "name": "Service call",
      "description": "Visit to find and fix a problem with heating or cooling",
      "minutes": 120,
      "skills": [
        "Diagnostics and repair"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Tune-up",
      "description": "Seasonal check and cleaning of a furnace or air conditioner",
      "minutes": 90,
      "skills": [
        "Maintenance"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Thermostat install",
      "description": "Install and set up a new thermostat",
      "minutes": 60,
      "skills": [
        "Thermostats"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Replacement estimate",
      "description": "Look at your current system and plan a new or replacement unit",
      "minutes": 60,
      "skills": [
        "System estimates"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "What should I do if I smell gas?",
      "section": "Service",
      "content": "Leave the home right away, do not switch anything on or off, and call your gas company or 911 from outside."
    },
    {
      "title": "How often should I get a tune-up?",
      "section": "Service",
      "content": "Most homes do well with a check once a year for each system, often cooling in spring and heating in fall."
    },
    {
      "title": "Do I need to be home for the visit?",
      "section": "Visit",
      "content": "Yes, we ask that an adult be home so we can reach the indoor unit and the thermostat."
    },
    {
      "title": "How can I get ready for the visit?",
      "section": "Visit",
      "content": "Please clear a path to the furnace, air handler and outdoor unit, and keep pets in another room."
    }
  ]
}$spec$::jsonb
);

-- Insurance Agency Template (insurance → insurance)
-- Research sources:
--   https://www.nationwide.com/lc/resources/auto-insurance/articles/what-you-need-for-a-quote
--   https://www.johnbaileyco.com/post/your-guide-to-an-annual-insurance-review/
--   https://steininsurance.com/5-reasons-for-an-annual-insurance-review/
--   https://www.experian.com/blogs/ask-experian/how-long-does-it-take-to-get-car-insurance/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a014', 'Insurance Agency Template', 'insurance', 'insurance',
  $spec${
  "skills": [
    {
      "name": "Personal lines",
      "description": "Home, auto, and renters coverage."
    },
    {
      "name": "Commercial lines",
      "description": "Coverage for small businesses."
    },
    {
      "name": "Policy service",
      "description": "Reviews, changes, and everyday account help."
    }
  ],
  "resources": [
    {
      "name": "Office 1",
      "description": "Main office for in-person appointments."
    },
    {
      "name": "Office 2",
      "description": "Second office for in-person appointments."
    },
    {
      "name": "Phone Line 1",
      "description": "For phone and video appointments."
    },
    {
      "name": "Phone Line 2",
      "description": "For phone and video appointments."
    }
  ],
  "staff": [
    {
      "name": "Agent 1",
      "skills": [
        "Personal lines",
        "Commercial lines",
        "Policy service"
      ]
    },
    {
      "name": "Agent 2",
      "skills": [
        "Personal lines",
        "Policy service"
      ]
    }
  ],
  "services": [
    {
      "name": "Insurance quote",
      "description": "Go over what you want covered so an agent can prepare a quote.",
      "minutes": 30,
      "skills": [
        "Personal lines"
      ],
      "resources": [
        "Office 1",
        "Office 2",
        "Phone Line 1",
        "Phone Line 2"
      ]
    },
    {
      "name": "Policy review",
      "description": "Walk through your current policies to make sure they still fit your life.",
      "minutes": 45,
      "skills": [
        "Policy service"
      ],
      "resources": [
        "Office 1",
        "Office 2",
        "Phone Line 1",
        "Phone Line 2"
      ]
    },
    {
      "name": "Policy change",
      "description": "Add or remove a car, driver, or address on an existing policy.",
      "minutes": 15,
      "skills": [
        "Policy service"
      ],
      "resources": [
        "Office 1",
        "Phone Line 1",
        "Phone Line 2"
      ]
    },
    {
      "name": "Business insurance consultation",
      "description": "Talk through coverage needs for a small business.",
      "minutes": 60,
      "skills": [
        "Commercial lines"
      ],
      "resources": [
        "Office 1"
      ]
    },
    {
      "name": "New client meeting",
      "description": "Get to know the agency and set up your accounts.",
      "minutes": 30,
      "skills": [
        "Personal lines",
        "Policy service"
      ],
      "resources": [
        "Office 1",
        "Office 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "What should I have ready for a quote?",
      "section": "Booking",
      "content": "It helps to have your driver's license, vehicle details, home address, and your current policy if you have one. An agent will go over the rest with you."
    },
    {
      "title": "Can I do my appointment by phone?",
      "section": "Visit",
      "content": "Yes. Many appointments can be done by phone or in the office. Let us know which you prefer when you book."
    },
    {
      "title": "Can you tell me if something is covered?",
      "section": "Policies",
      "content": "We can't answer coverage questions on this call. An agent will review your policy with you during an appointment."
    },
    {
      "title": "How do I report a claim?",
      "section": "Service",
      "content": "We can take your details and pass them to an agent. You can also contact your insurance company's claims line, listed on your policy documents."
    }
  ]
}$spec$::jsonb
);

-- Landscaping Service Template (landscaping → landscaping)
-- Research sources:
--   https://www.getjobber.com/academy/lawn-care/how-to-estimate-lawn-care/
--   https://www.itmlandscape.com/blog/what-is-included-in-professional-lawn-maintenance/
--   https://cboutdoorservices.com/resources/how-much-does-spring-cleanup-cost/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a015', 'Landscaping Service Template', 'landscaping', 'landscaping',
  $spec${
  "skills": [
    {
      "name": "Lawn care",
      "description": "Mowing, trimming and edging"
    },
    {
      "name": "Cleanup",
      "description": "Seasonal leaf and debris cleanup"
    },
    {
      "name": "Beds and shrubs",
      "description": "Mulching, weeding and shrub trimming"
    },
    {
      "name": "Estimates",
      "description": "Walking the property to plan and quote work"
    }
  ],
  "resources": [
    {
      "name": "Crew A",
      "description": "Crew with truck, trailer and equipment"
    },
    {
      "name": "Crew B",
      "description": "Second crew"
    }
  ],
  "staff": [
    {
      "name": "Crew Lead 1",
      "skills": [
        "Lawn care",
        "Cleanup",
        "Beds and shrubs",
        "Estimates"
      ]
    },
    {
      "name": "Crew Lead 2",
      "skills": [
        "Lawn care",
        "Cleanup",
        "Estimates"
      ]
    }
  ],
  "services": [
    {
      "name": "Walkthrough estimate",
      "description": "Visit to walk the property and plan the work",
      "minutes": 30,
      "skills": [
        "Estimates"
      ],
      "resources": [
        "Crew A",
        "Crew B"
      ]
    },
    {
      "name": "Lawn mowing",
      "description": "Mow, trim and edge the lawn",
      "minutes": 60,
      "skills": [
        "Lawn care"
      ],
      "resources": [
        "Crew A",
        "Crew B"
      ]
    },
    {
      "name": "Spring or fall cleanup",
      "description": "Clear leaves, sticks and debris from lawn and beds",
      "minutes": 180,
      "skills": [
        "Cleanup"
      ],
      "resources": [
        "Crew A",
        "Crew B"
      ]
    },
    {
      "name": "Mulch and bed care",
      "description": "Weed beds and put down fresh mulch",
      "minutes": 120,
      "skills": [
        "Beds and shrubs"
      ],
      "resources": [
        "Crew A",
        "Crew B"
      ]
    },
    {
      "name": "Hedge and shrub trimming",
      "description": "Trim and shape hedges and shrubs",
      "minutes": 120,
      "skills": [
        "Beds and shrubs"
      ],
      "resources": [
        "Crew A",
        "Crew B"
      ]
    }
  ],
  "docs": [
    {
      "title": "Do I need to be home?",
      "section": "Visit",
      "content": "No, as long as we can reach the yard. Please unlock gates and let us know about any pets."
    },
    {
      "title": "What happens if it rains?",
      "section": "Policies",
      "content": "If the weather is too wet to work safely or well, we move the visit to the next good day."
    },
    {
      "title": "Can I set up regular mowing?",
      "section": "Booking",
      "content": "Many customers have regular mowing through the season. We can book your first visit and talk about a schedule then."
    },
    {
      "title": "Do you haul away yard waste?",
      "section": "Service",
      "content": "We can take away the leaves and clippings from a cleanup. Just ask when you book so we can plan for it."
    }
  ]
}$spec$::jsonb
);

-- Lash & Brow Studio Template (lash-studio → lash_studio)
-- Research sources:
--   https://www.lashandcompany.com/co-johnstown/what-is-a-2-week-fill/
--   https://thelashprofessional.com/blogs/info-for-clients/how-long-do-eyelash-extensions-take
--   https://lashaffair.com/blogs/lash-artist-blog/lash-extension-fills
--   https://www.artoflash.com/lashliftandtint
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a016', 'Lash & Brow Studio Template', 'lash-studio', 'lash_studio',
  $spec${
  "skills": [
    {
      "name": "Classic lashes",
      "description": "Applying one extension to each natural lash."
    },
    {
      "name": "Volume lashes",
      "description": "Applying fans of several fine extensions to each natural lash."
    },
    {
      "name": "Lash lift & tint",
      "description": "Curling and tinting natural lashes without extensions."
    }
  ],
  "resources": [
    {
      "name": "Station 1",
      "description": "A lash bed and work station."
    },
    {
      "name": "Station 2",
      "description": "A lash bed and work station."
    }
  ],
  "staff": [
    {
      "name": "Lash Artist 1",
      "skills": [
        "Classic lashes",
        "Volume lashes",
        "Lash lift & tint"
      ]
    },
    {
      "name": "Lash Artist 2",
      "skills": [
        "Classic lashes",
        "Lash lift & tint"
      ]
    }
  ],
  "services": [
    {
      "name": "Lash consultation",
      "description": "A short visit to talk through styles and lengths before a first set.",
      "minutes": 15,
      "skills": [
        "Classic lashes"
      ],
      "resources": [
        "Station 1",
        "Station 2"
      ]
    },
    {
      "name": "Classic full set",
      "description": "A full new set of classic lash extensions.",
      "minutes": 120,
      "skills": [
        "Classic lashes"
      ],
      "resources": [
        "Station 1",
        "Station 2"
      ]
    },
    {
      "name": "Volume full set",
      "description": "A full new set of volume lash extensions.",
      "minutes": 150,
      "skills": [
        "Volume lashes"
      ],
      "resources": [
        "Station 1",
        "Station 2"
      ]
    },
    {
      "name": "Lash fill",
      "description": "Replaces extensions that have shed since your last visit.",
      "minutes": 60,
      "skills": [
        "Classic lashes"
      ],
      "resources": [
        "Station 1",
        "Station 2"
      ]
    },
    {
      "name": "Lash lift & tint",
      "description": "Curls and darkens your natural lashes.",
      "minutes": 60,
      "skills": [
        "Lash lift & tint"
      ],
      "resources": [
        "Station 1",
        "Station 2"
      ]
    },
    {
      "name": "Lash removal",
      "description": "Safe removal of existing lash extensions.",
      "minutes": 30,
      "skills": [
        "Classic lashes"
      ],
      "resources": [
        "Station 1",
        "Station 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "How often should I come in for a fill?",
      "section": "Service",
      "content": "Most clients book a fill every two to three weeks. Wait much longer and you may need a new full set instead."
    },
    {
      "title": "How should I arrive for my appointment?",
      "section": "Visit",
      "content": "Please come with clean eyes and no mascara or eye makeup. You will be lying down with your eyes closed for most of the visit."
    },
    {
      "title": "Can I get a fill if another studio did my lashes?",
      "section": "Booking",
      "content": "Please tell us when you book. Depending on how many extensions are left, we may recommend a removal and a new set."
    }
  ]
}$spec$::jsonb
);

-- Law Firm Template (law-firm → law_firm)
-- Research sources:
--   https://www.johnfoy.com/faqs/how-long-is-a-free-consultation-with-a-lawyer/
--   https://www.enjuris.com/personal-injury-law/free-lawyer-consultation/
--   https://www.chopranocerino.com/faqs/how-often-will-i-receive-updates-from-my-lawyer/
--   https://brobertsonlaw.com/initial-consultation-firm-entail-long-take/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a017', 'Law Firm Template', 'law-firm', 'law_firm',
  $spec${
  "skills": [
    {
      "name": "Case evaluation",
      "description": "Meeting new clients to review a possible case."
    },
    {
      "name": "Case management",
      "description": "Working and updating open cases."
    },
    {
      "name": "Client intake",
      "description": "Gathering details and documents from new clients."
    }
  ],
  "resources": [
    {
      "name": "Office 1",
      "description": "Main office for client meetings."
    },
    {
      "name": "Office 2",
      "description": "Second office or conference room."
    },
    {
      "name": "Phone Line 1",
      "description": "For phone and video calls."
    },
    {
      "name": "Phone Line 2",
      "description": "For phone and video calls."
    }
  ],
  "staff": [
    {
      "name": "Attorney 1",
      "skills": [
        "Case evaluation",
        "Case management",
        "Client intake"
      ]
    },
    {
      "name": "Attorney 2",
      "skills": [
        "Client intake",
        "Case management",
        "Case evaluation"
      ]
    }
  ],
  "services": [
    {
      "name": "Consultation",
      "description": "First meeting with an attorney to talk through what happened.",
      "minutes": 60,
      "skills": [
        "Case evaluation"
      ],
      "resources": [
        "Office 1",
        "Office 2",
        "Phone Line 1",
        "Phone Line 2"
      ]
    },
    {
      "name": "Phone consultation",
      "description": "A first conversation with an attorney by phone.",
      "minutes": 30,
      "skills": [
        "Case evaluation"
      ],
      "resources": [
        "Phone Line 1",
        "Phone Line 2"
      ]
    },
    {
      "name": "Case status call",
      "description": "A call for current clients to get an update on their case.",
      "minutes": 15,
      "skills": [
        "Case management"
      ],
      "resources": [
        "Office 1",
        "Phone Line 1",
        "Phone Line 2"
      ]
    },
    {
      "name": "Document drop-off",
      "description": "Bring in paperwork, photos, or records for your file.",
      "minutes": 15,
      "skills": [
        "Client intake"
      ],
      "resources": [
        "Office 1",
        "Office 2"
      ]
    },
    {
      "name": "Client meeting",
      "description": "A longer meeting for current clients to go over their case.",
      "minutes": 60,
      "skills": [
        "Case management"
      ],
      "resources": [
        "Office 1",
        "Office 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "What should I bring to my consultation?",
      "section": "Booking",
      "content": "Bring any documents you have about your situation, such as reports, photos, letters, bills, and names of witnesses. An attorney will review your situation during the consultation."
    },
    {
      "title": "Do I have a case?",
      "section": "Policies",
      "content": "We can't answer that on this call. An attorney will review your situation during the consultation."
    },
    {
      "title": "Can I meet by phone instead of in person?",
      "section": "Visit",
      "content": "Yes. Consultations can often be done by phone or in the office. Let us know which you prefer when you book."
    },
    {
      "title": "How do I get an update on my case?",
      "section": "Service",
      "content": "Current clients can book a case status call, or we can take a message for your attorney."
    }
  ]
}$spec$::jsonb
);

-- Locksmith Template (locksmith → locksmith)
-- Research sources:
--   https://www.popalock.com/residential-services/lockout-service/
--   https://westcoastlocksmith.com/blog/how-long-does-it-take-to-rekey-a-lock/
--   https://www.angi.com/articles/should-you-replace-or-rekey-locks.htm
--   https://carkeyline.com/how-long-does-it-take-a-locksmith-to-make-or-program-a-car-key/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a018', 'Locksmith Template', 'locksmith', 'locksmith',
  $spec${
  "skills": [
    {
      "name": "Lockouts",
      "description": "Opening homes, businesses and vehicles when you're locked out."
    },
    {
      "name": "Rekeying",
      "description": "Changing the lock's pins so old keys stop working."
    },
    {
      "name": "Lock Repair and Installation",
      "description": "Fixing, replacing and installing locks and deadbolts."
    },
    {
      "name": "Car Keys",
      "description": "Cutting and programming vehicle keys and fobs."
    }
  ],
  "resources": [
    {
      "name": "Van 1",
      "description": "Service van with tools and key machine."
    },
    {
      "name": "Van 2",
      "description": "Second service van."
    }
  ],
  "staff": [
    {
      "name": "Locksmith 1",
      "skills": [
        "Lockouts",
        "Rekeying",
        "Lock Repair and Installation",
        "Car Keys"
      ]
    },
    {
      "name": "Locksmith 2",
      "skills": [
        "Lockouts",
        "Rekeying",
        "Lock Repair and Installation"
      ]
    }
  ],
  "services": [
    {
      "name": "Service call",
      "description": "We come out to look at a lock problem and fix what we can on the spot.",
      "minutes": 60,
      "skills": [
        "Lock Repair and Installation"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Lockout",
      "description": "Getting you back into your home or business.",
      "minutes": 30,
      "skills": [
        "Lockouts"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Car lockout",
      "description": "Getting you back into your vehicle.",
      "minutes": 30,
      "skills": [
        "Lockouts"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Rekey",
      "description": "Rekeying your locks so old keys no longer work.",
      "minutes": 60,
      "skills": [
        "Rekeying"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Deadbolt installation",
      "description": "Installing a new deadbolt or replacing an old one.",
      "minutes": 60,
      "skills": [
        "Lock Repair and Installation"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Car key replacement",
      "description": "Cutting and programming a new key or fob for your vehicle.",
      "minutes": 60,
      "skills": [
        "Car Keys"
      ],
      "resources": [
        "Van 1"
      ]
    }
  ],
  "docs": [
    {
      "title": "What do I need to show when you arrive?",
      "section": "Visit",
      "content": "We'll ask for a photo ID and something showing you live at the address or own the vehicle before we open anything."
    },
    {
      "title": "Should I rekey or replace my locks?",
      "section": "Service",
      "content": "If your locks work fine, rekeying is usually enough to make old keys stop working. If a lock is damaged or you want an upgrade, we can replace it."
    },
    {
      "title": "Can you make a key for my car?",
      "section": "Service",
      "content": "We can make keys for many vehicles. Have the year, make and model ready when you call."
    },
    {
      "title": "How soon can you get here?",
      "section": "Booking",
      "content": "It depends on where our locksmiths are working. We'll tell you what's available when you book."
    }
  ]
}$spec$::jsonb
);

-- Mobile Tire Shop Template (mobile-tire → mobile_tire)
-- Research sources:
--   https://wrench.com/service/flat-tire-repair/
--   https://motorweek.org/your-drive/mobile-tire-installation/
--   https://www.tirerack.com/mobile-tire-installation
--   https://suprememobiletire.com/mobile-tire-services/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a019', 'Mobile Tire Shop Template', 'mobile-tire', 'mobile_tire',
  $spec${
  "skills": [
    {
      "name": "Flat Repair",
      "description": "Patching and plugging repairable punctures, spare swaps."
    },
    {
      "name": "Tire Installation",
      "description": "Mounting and balancing new tires on site."
    },
    {
      "name": "Rotation",
      "description": "Rotating tires and checking pressure and tread."
    },
    {
      "name": "TPMS Service",
      "description": "Servicing and resetting tire pressure sensors."
    }
  ],
  "resources": [
    {
      "name": "Service Truck 1",
      "description": "Service truck with tire machine and balancer."
    },
    {
      "name": "Service Truck 2",
      "description": "Second service truck."
    }
  ],
  "staff": [
    {
      "name": "Technician 1",
      "skills": [
        "Flat Repair",
        "Tire Installation",
        "Rotation",
        "TPMS Service"
      ]
    },
    {
      "name": "Technician 2",
      "skills": [
        "Flat Repair",
        "Rotation"
      ]
    }
  ],
  "services": [
    {
      "name": "Flat repair",
      "description": "We come to you and patch or plug a repairable puncture.",
      "minutes": 45,
      "skills": [
        "Flat Repair"
      ],
      "resources": [
        "Service Truck 1",
        "Service Truck 2"
      ]
    },
    {
      "name": "Spare tire swap",
      "description": "We put your spare on so you can get moving.",
      "minutes": 30,
      "skills": [
        "Flat Repair"
      ],
      "resources": [
        "Service Truck 1",
        "Service Truck 2"
      ]
    },
    {
      "name": "Tire replacement",
      "description": "New tires mounted and balanced at your home or work.",
      "minutes": 60,
      "skills": [
        "Tire Installation"
      ],
      "resources": [
        "Service Truck 1",
        "Service Truck 2"
      ]
    },
    {
      "name": "Tire rotation",
      "description": "Rotating your tires and checking pressure and tread.",
      "minutes": 30,
      "skills": [
        "Rotation"
      ],
      "resources": [
        "Service Truck 1",
        "Service Truck 2"
      ]
    },
    {
      "name": "Seasonal tire changeover",
      "description": "Swapping between winter and all-season or summer tires.",
      "minutes": 60,
      "skills": [
        "Tire Installation",
        "Rotation"
      ],
      "resources": [
        "Service Truck 1",
        "Service Truck 2"
      ]
    },
    {
      "name": "Tire pressure sensor service",
      "description": "Checking, replacing or resetting a tire pressure sensor.",
      "minutes": 45,
      "skills": [
        "TPMS Service",
        "Tire Installation"
      ],
      "resources": [
        "Service Truck 1"
      ]
    }
  ],
  "docs": [
    {
      "title": "Where can you do the work?",
      "section": "Visit",
      "content": "At your home, work, or another spot where it's allowed and there's a flat, safe place to park."
    },
    {
      "title": "Do I need to be there?",
      "section": "Visit",
      "content": "We need access to the vehicle and the keys, plus the wheel lock key if your wheels have locks."
    },
    {
      "title": "Can every flat tire be patched?",
      "section": "Service",
      "content": "Not always. Damage on the sidewall or a large puncture usually can't be repaired, so our technician will check and tell you your options."
    },
    {
      "title": "Do you bring the tires?",
      "section": "Booking",
      "content": "We can bring tires that fit your vehicle. Tell us the tire size printed on the sidewall when you book."
    }
  ]
}$spec$::jsonb
);

-- Nail Salon Template (nail-salon → nail_salon)
-- Research sources:
--   https://btartboxnails.com/blogs/btartbox-official-guides/how-long-does-a-manicure-take
--   https://btartboxnails.com/blogs/btartbox-official-guides/how-long-does-a-pedicure-take
--   https://polishpops.com/blogs/news/how-long-does-it-take-to-get-nails-done
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a020', 'Nail Salon Template', 'nail-salon', 'nail_salon',
  $spec${
  "skills": [
    {
      "name": "Manicures",
      "description": "Classic manicures with regular polish."
    },
    {
      "name": "Pedicures",
      "description": "Foot soak, nail care and polish."
    },
    {
      "name": "Gel & enhancements",
      "description": "Gel polish, acrylic and other nail enhancements."
    },
    {
      "name": "Nail art",
      "description": "Hand-painted designs, French tips and accents."
    }
  ],
  "resources": [
    {
      "name": "Station 1",
      "description": "A manicure table."
    },
    {
      "name": "Station 2",
      "description": "A manicure table."
    },
    {
      "name": "Station 3",
      "description": "A pedicure chair with a foot basin."
    }
  ],
  "staff": [
    {
      "name": "Nail Tech 1",
      "skills": [
        "Manicures",
        "Pedicures",
        "Gel & enhancements",
        "Nail art"
      ]
    },
    {
      "name": "Nail Tech 2",
      "skills": [
        "Manicures",
        "Pedicures"
      ]
    }
  ],
  "services": [
    {
      "name": "Manicure",
      "description": "Nail shaping, cuticle care and regular polish.",
      "minutes": 30,
      "skills": [
        "Manicures"
      ],
      "resources": [
        "Station 1",
        "Station 2"
      ]
    },
    {
      "name": "Pedicure",
      "description": "Foot soak, nail shaping, cuticle care, callus smoothing and polish.",
      "minutes": 45,
      "skills": [
        "Pedicures"
      ],
      "resources": [
        "Station 3"
      ]
    },
    {
      "name": "Gel manicure",
      "description": "A manicure finished with long-lasting gel polish.",
      "minutes": 60,
      "skills": [
        "Manicures",
        "Gel & enhancements"
      ],
      "resources": [
        "Station 1",
        "Station 2"
      ]
    },
    {
      "name": "Gel pedicure",
      "description": "A pedicure finished with long-lasting gel polish.",
      "minutes": 60,
      "skills": [
        "Pedicures",
        "Gel & enhancements"
      ],
      "resources": [
        "Station 3"
      ]
    },
    {
      "name": "Acrylic full set",
      "description": "A new set of acrylic nail enhancements.",
      "minutes": 90,
      "skills": [
        "Gel & enhancements"
      ],
      "resources": [
        "Station 1",
        "Station 2"
      ]
    },
    {
      "name": "Nail art",
      "description": "Designs or French tips added to a manicure.",
      "minutes": 15,
      "skills": [
        "Nail art"
      ],
      "resources": [
        "Station 1",
        "Station 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "Do I need an appointment?",
      "section": "Booking",
      "content": "Appointments are recommended so we can hold a station for you. We take walk-ins when a nail tech is free."
    },
    {
      "title": "How long will my visit take?",
      "section": "Visit",
      "content": "It depends on the service. A regular manicure is shorter than a gel or acrylic service, and nail art adds a little time. We can give you an estimate when you book."
    },
    {
      "title": "Can you take off my old gel or acrylic nails?",
      "section": "Service",
      "content": "Yes. Please mention it when you book so we allow enough time for removal."
    },
    {
      "title": "Can I book a manicure and pedicure together?",
      "section": "Booking",
      "content": "Yes. Let us know and we will schedule both services back to back."
    }
  ]
}$spec$::jsonb
);

-- Quick Lube / Oil Change Template (oil-change → oil_change)
-- Research sources:
--   https://www.expresslubeplano.com/blog/quick-lube-visit-what-to-expect-step-by-step/
--   https://www.expressluberichlandhills.com/blog/what-is-quick-lube-service-a-drivers-guide/
--   https://www.vioc.com/oil-change/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a021', 'Quick Lube / Oil Change Template', 'oil-change', 'oil_change',
  $spec${
  "skills": [
    {
      "name": "Oil Service",
      "description": "Draining and refilling engine oil and replacing the filter."
    },
    {
      "name": "Tire Rotation",
      "description": "Rotating tires and setting pressure."
    },
    {
      "name": "Quick Parts",
      "description": "Swapping air filters, cabin filters, wiper blades and bulbs."
    },
    {
      "name": "Fluid Service",
      "description": "Flushing and replacing coolant and other fluids."
    }
  ],
  "resources": [
    {
      "name": "Lane 1",
      "description": "Service lane."
    },
    {
      "name": "Lane 2",
      "description": "Second service lane."
    }
  ],
  "staff": [
    {
      "name": "Lube Tech 1",
      "skills": [
        "Oil Service",
        "Tire Rotation",
        "Quick Parts",
        "Fluid Service"
      ]
    },
    {
      "name": "Lube Tech 2",
      "skills": [
        "Oil Service",
        "Tire Rotation",
        "Quick Parts"
      ]
    }
  ],
  "services": [
    {
      "name": "Oil Change",
      "description": "Oil and filter change with a quick check of fluids and tire pressure.",
      "minutes": 30,
      "skills": [
        "Oil Service"
      ],
      "resources": [
        "Lane 1",
        "Lane 2"
      ]
    },
    {
      "name": "Tire Rotation",
      "description": "Rotating your tires and setting the pressure.",
      "minutes": 30,
      "skills": [
        "Tire Rotation"
      ],
      "resources": [
        "Lane 1",
        "Lane 2"
      ]
    },
    {
      "name": "Oil change and tire rotation",
      "description": "Both services in one visit.",
      "minutes": 45,
      "skills": [
        "Oil Service",
        "Tire Rotation"
      ],
      "resources": [
        "Lane 1",
        "Lane 2"
      ]
    },
    {
      "name": "Air filter replacement",
      "description": "Replacing the engine or cabin air filter.",
      "minutes": 15,
      "skills": [
        "Quick Parts"
      ],
      "resources": [
        "Lane 1",
        "Lane 2"
      ]
    },
    {
      "name": "Wiper blade replacement",
      "description": "New front or rear wiper blades.",
      "minutes": 15,
      "skills": [
        "Quick Parts"
      ],
      "resources": [
        "Lane 1",
        "Lane 2"
      ]
    },
    {
      "name": "Coolant service",
      "description": "Draining and refilling the engine coolant.",
      "minutes": 60,
      "skills": [
        "Fluid Service"
      ],
      "resources": [
        "Lane 1",
        "Lane 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "Do I need an appointment?",
      "section": "Booking",
      "content": "Booking ahead holds a lane for you. We also take drive-ups when a lane is open."
    },
    {
      "title": "Which oil does my car need?",
      "section": "Service",
      "content": "We follow the recommendation in your owner's manual for your make and model. If you have a preference, just tell us."
    },
    {
      "title": "How often should I change my oil?",
      "section": "Service",
      "content": "We recommend following your owner's manual or your car's oil-life reminder. It depends on the vehicle, the oil and how you drive."
    },
    {
      "title": "Can I wait while you work?",
      "section": "Visit",
      "content": "Yes, we finish most services while you wait."
    }
  ]
}$spec$::jsonb
);

-- Personal Training Template (personal-trainer → personal_trainer)
-- Research sources:
--   https://www.issaonline.com/blog/post/build-your-business-personal-training-consultation-guide
--   https://blog.nasm.org/personal-training-lesson-the-30-minute-model
--   https://www.coreresults.net/our-process/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a022', 'Personal Training Template', 'personal-trainer', 'personal_trainer',
  $spec${
  "skills": [
    {
      "name": "Personal training",
      "description": "One-on-one coached workouts."
    },
    {
      "name": "Fitness assessment",
      "description": "Movement screening and starting-point measurements."
    },
    {
      "name": "Small group training",
      "description": "Coaching two to four people together."
    }
  ],
  "resources": [
    {
      "name": "Studio 1",
      "description": "The training floor with equipment."
    },
    {
      "name": "Studio 2",
      "description": "The training floor with equipment."
    }
  ],
  "staff": [
    {
      "name": "Trainer 1",
      "skills": [
        "Personal training",
        "Fitness assessment",
        "Small group training"
      ]
    },
    {
      "name": "Trainer 2",
      "skills": [
        "Personal training"
      ]
    }
  ],
  "services": [
    {
      "name": "Intro consultation",
      "description": "A first meeting to talk about your goals, experience and schedule.",
      "minutes": 30,
      "skills": [
        "Personal training"
      ],
      "resources": [
        "Studio 1",
        "Studio 2"
      ]
    },
    {
      "name": "Personal training session",
      "description": "A one-on-one coached workout.",
      "minutes": 60,
      "skills": [
        "Personal training"
      ],
      "resources": [
        "Studio 1",
        "Studio 2"
      ]
    },
    {
      "name": "Express session",
      "description": "A shorter one-on-one coached workout.",
      "minutes": 30,
      "skills": [
        "Personal training"
      ],
      "resources": [
        "Studio 1",
        "Studio 2"
      ]
    },
    {
      "name": "Fitness assessment",
      "description": "A movement screen and baseline measurements to plan your program.",
      "minutes": 60,
      "skills": [
        "Fitness assessment"
      ],
      "resources": [
        "Studio 1",
        "Studio 2"
      ]
    },
    {
      "name": "Partner training session",
      "description": "A coached workout for two to four people training together.",
      "minutes": 60,
      "skills": [
        "Personal training",
        "Small group training"
      ],
      "resources": [
        "Studio 1",
        "Studio 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "I'm a beginner. Where do I start?",
      "section": "Booking",
      "content": "Start with an intro consultation. We will talk about your goals and experience and suggest a plan that fits."
    },
    {
      "title": "What should I bring to a session?",
      "section": "Visit",
      "content": "Wear comfortable workout clothes and athletic shoes, and bring a water bottle. We provide the equipment."
    },
    {
      "title": "Can I train with a friend?",
      "section": "Service",
      "content": "Yes. We offer partner sessions where two or more people train together with one trainer."
    },
    {
      "title": "What if I need to reschedule?",
      "section": "Policies",
      "content": "Please give us as much notice as you can so your trainer can offer the time to someone else."
    }
  ]
}$spec$::jsonb
);

-- Pest Control Template (pest-control → pest_control)
-- Research sources:
--   https://protecpestmgmt.com/pest-control/what-happens-at-each-quarterly-pest-control-visit/
--   https://www.carolinapest.com/quarterly-pest-control/
--   https://griggsbrowne.com/blog/how-often-should-pest-control-be-done/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a023', 'Pest Control Template', 'pest-control', 'pest_control',
  $spec${
  "skills": [
    {
      "name": "General pest",
      "description": "Ants, roaches, spiders and other common insects"
    },
    {
      "name": "Rodent control",
      "description": "Mice and rats: trapping and sealing entry points"
    },
    {
      "name": "Termite inspection",
      "description": "Checking for termites and wood-destroying insects"
    }
  ],
  "resources": [
    {
      "name": "Van 1",
      "description": "Service vehicle with equipment and products"
    },
    {
      "name": "Van 2",
      "description": "Second service vehicle"
    }
  ],
  "staff": [
    {
      "name": "Technician 1",
      "skills": [
        "General pest",
        "Rodent control",
        "Termite inspection"
      ]
    },
    {
      "name": "Technician 2",
      "skills": [
        "General pest"
      ]
    }
  ],
  "services": [
    {
      "name": "Inspection visit",
      "description": "Inside and outside check to find what pests are present and how they get in",
      "minutes": 60,
      "skills": [
        "General pest"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Treatment visit",
      "description": "Treatment inside and around the home for common insects",
      "minutes": 60,
      "skills": [
        "General pest"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Follow-up visit",
      "description": "Return visit to check results and re-treat if needed",
      "minutes": 60,
      "skills": [
        "General pest"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Rodent control visit",
      "description": "Set traps and find and seal entry points for mice or rats",
      "minutes": 90,
      "skills": [
        "Rodent control"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Termite inspection",
      "description": "Check the home for signs of termites and wood damage",
      "minutes": 90,
      "skills": [
        "Termite inspection"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "Do I need to leave the home during treatment?",
      "section": "Visit",
      "content": "It depends on the treatment. Your technician will tell you if you or your pets need to stay out of an area and for how long."
    },
    {
      "title": "What about my pets?",
      "section": "Visit",
      "content": "Please keep pets away from treated areas until they are dry, and let us know about any pets when you book."
    },
    {
      "title": "How often do I need service?",
      "section": "Service",
      "content": "Many homes use regular visits a few times a year to keep pests out. We can suggest a schedule after the first inspection."
    },
    {
      "title": "How do I get ready for the first visit?",
      "section": "Visit",
      "content": "Please make sure we can reach the areas where you have seen pests, like under sinks and along baseboards."
    }
  ]
}$spec$::jsonb
);

-- Photography Studio Template (photography → photography)
-- Research sources:
--   https://mikeglatzerphotos.com/blog/how-long-is-a-photo-session/
--   https://www.kimhildebrand.com/mini-session-vs-full-photo-session-whats-the-difference/
--   https://photosbybailey.com/2024/01/11/what-to-expect-studio-session/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a024', 'Photography Studio Template', 'photography', 'photography',
  $spec${
  "skills": [
    {
      "name": "Portraits",
      "description": "Headshots, family, and individual portraits."
    },
    {
      "name": "Events",
      "description": "Photographing events on location."
    },
    {
      "name": "Client consultations",
      "description": "Planning sessions with clients."
    }
  ],
  "resources": [
    {
      "name": "Studio 1",
      "description": "Main studio."
    },
    {
      "name": "Studio 2",
      "description": "Second studio or backdrop area."
    },
    {
      "name": "On Location 1",
      "description": "Sessions held away from the studio."
    },
    {
      "name": "On Location 2",
      "description": "Sessions held away from the studio."
    }
  ],
  "staff": [
    {
      "name": "Photographer 1",
      "skills": [
        "Portraits",
        "Events",
        "Client consultations"
      ]
    },
    {
      "name": "Photographer 2",
      "skills": [
        "Portraits",
        "Client consultations"
      ]
    }
  ],
  "services": [
    {
      "name": "Session consultation",
      "description": "Plan your shoot: the look, the outfits, and the location.",
      "minutes": 30,
      "skills": [
        "Client consultations"
      ],
      "resources": [
        "Studio 1",
        "Studio 2"
      ]
    },
    {
      "name": "Headshot session",
      "description": "A studio session for professional headshots.",
      "minutes": 30,
      "skills": [
        "Portraits"
      ],
      "resources": [
        "Studio 1",
        "Studio 2"
      ]
    },
    {
      "name": "Mini session",
      "description": "A short portrait session.",
      "minutes": 30,
      "skills": [
        "Portraits"
      ],
      "resources": [
        "Studio 1",
        "Studio 2",
        "On Location 1",
        "On Location 2"
      ]
    },
    {
      "name": "Family portrait session",
      "description": "A portrait session for a family or group.",
      "minutes": 60,
      "skills": [
        "Portraits"
      ],
      "resources": [
        "Studio 1",
        "On Location 1",
        "On Location 2"
      ]
    },
    {
      "name": "Event coverage",
      "description": "Photographing an event on location.",
      "minutes": 120,
      "skills": [
        "Events"
      ],
      "resources": [
        "On Location 1",
        "On Location 2"
      ]
    },
    {
      "name": "Photo viewing",
      "description": "Look over your photos and choose your favorites.",
      "minutes": 45,
      "skills": [
        "Client consultations"
      ],
      "resources": [
        "Studio 1",
        "Studio 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "What should I wear?",
      "section": "Visit",
      "content": "Solid colors and clothes you feel comfortable in usually work well. We're happy to go over outfit ideas at a session consultation."
    },
    {
      "title": "Can we shoot somewhere other than the studio?",
      "section": "Service",
      "content": "Some sessions can be done on location. Let us know where you have in mind when you book."
    },
    {
      "title": "How early should I arrive?",
      "section": "Visit",
      "content": "Please arrive a few minutes early so you have time to settle in before your session starts."
    },
    {
      "title": "When will I see my photos?",
      "section": "Policies",
      "content": "Timing depends on the session. Your photographer will go over what to expect when you book."
    }
  ]
}$spec$::jsonb
);

-- Plumbing Service Template (plumber → plumber)
-- Research sources:
--   https://www.mrrooter.com/yavapai-and-coconino-counties/about-us/blog/how-long-does-a-plumber-take/
--   https://jblantonplumbing.com/knowledge-hub/what-to-expect-during-drain-cleaning-service
--   https://thesewerkings.com/blog/how-long-does-drain-cleaning-take/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a025', 'Plumbing Service Template', 'plumber', 'plumber',
  $spec${
  "skills": [
    {
      "name": "Diagnostics and repair",
      "description": "Leaks, low pressure and general plumbing repairs"
    },
    {
      "name": "Drain cleaning",
      "description": "Clearing clogged sinks, tubs, toilets and main lines"
    },
    {
      "name": "Fixtures",
      "description": "Faucets, toilets, sinks and disposals"
    },
    {
      "name": "Water heaters",
      "description": "Repairing and replacing water heaters"
    }
  ],
  "resources": [
    {
      "name": "Van 1",
      "description": "Service van with tools and common parts"
    },
    {
      "name": "Van 2",
      "description": "Second service van"
    }
  ],
  "staff": [
    {
      "name": "Plumber 1",
      "skills": [
        "Diagnostics and repair",
        "Drain cleaning",
        "Fixtures",
        "Water heaters"
      ]
    },
    {
      "name": "Plumber 2",
      "skills": [
        "Drain cleaning",
        "Fixtures",
        "Diagnostics and repair"
      ]
    }
  ],
  "services": [
    {
      "name": "Service call",
      "description": "Visit to find and fix a plumbing problem, like a leak",
      "minutes": 120,
      "skills": [
        "Diagnostics and repair"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Drain cleaning",
      "description": "Clear a clogged sink, tub, shower or toilet drain",
      "minutes": 90,
      "skills": [
        "Drain cleaning"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Faucet or toilet repair",
      "description": "Repair or replace a faucet, toilet or garbage disposal",
      "minutes": 60,
      "skills": [
        "Fixtures"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Water heater service",
      "description": "Look at, repair or plan a replacement for a water heater",
      "minutes": 120,
      "skills": [
        "Water heaters"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    },
    {
      "name": "Sewer line camera inspection",
      "description": "Camera check of the main line for recurring backups",
      "minutes": 90,
      "skills": [
        "Drain cleaning"
      ],
      "resources": [
        "Van 1",
        "Van 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "What should I do if a pipe bursts?",
      "section": "Service",
      "content": "Turn off the main water shut-off valve if you can find it, then call us. If water is near outlets or appliances, stay away from it."
    },
    {
      "title": "Do I need to be home for the visit?",
      "section": "Visit",
      "content": "Yes, we ask that an adult be home so we can get in and go over the work with you."
    },
    {
      "title": "How do appointments work?",
      "section": "Booking",
      "content": "We book a time for a plumber to come out, and set aside enough time to find the problem and fix it when we can."
    },
    {
      "title": "Can you clear a main sewer line?",
      "section": "Service",
      "content": "Yes, we clear main lines as well as sink, tub and toilet drains. For repeat backups we can also do a camera inspection."
    }
  ]
}$spec$::jsonb
);

-- Real Estate Showings Template (real-estate → real_estate)
-- Research sources:
--   https://www.homelight.com/blog/buyer-how-long-should-a-house-showing-take/
--   https://www.rocketmortgage.com/learn/buyer-consultation
--   https://pathpost.com/what-to-expect-listing-appointment/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a026', 'Real Estate Showings Template', 'real-estate', 'real_estate',
  $spec${
  "skills": [
    {
      "name": "Buyer representation",
      "description": "Helping buyers find and tour homes."
    },
    {
      "name": "Seller representation",
      "description": "Helping owners list and sell a home."
    },
    {
      "name": "Showings",
      "description": "Touring properties with clients."
    }
  ],
  "resources": [
    {
      "name": "Office 1",
      "description": "Main office for client meetings."
    },
    {
      "name": "Office 2",
      "description": "Second office or meeting room."
    },
    {
      "name": "Phone Line 1",
      "description": "For phone and video calls."
    },
    {
      "name": "Phone Line 2",
      "description": "For phone and video calls."
    }
  ],
  "staff": [
    {
      "name": "Agent 1",
      "skills": [
        "Buyer representation",
        "Seller representation",
        "Showings"
      ]
    },
    {
      "name": "Agent 2",
      "skills": [
        "Buyer representation",
        "Showings"
      ]
    }
  ],
  "services": [
    {
      "name": "Buyer consult",
      "description": "Talk through what you want in a home and how buying works.",
      "minutes": 60,
      "skills": [
        "Buyer representation"
      ],
      "resources": [
        "Office 1",
        "Office 2",
        "Phone Line 1",
        "Phone Line 2"
      ]
    },
    {
      "name": "Showing",
      "description": "Tour a home with an agent.",
      "minutes": 30,
      "skills": [
        "Showings"
      ],
      "resources": [
        "Office 1",
        "Office 2"
      ]
    },
    {
      "name": "Listing appointment",
      "description": "Meet with an agent about selling your home.",
      "minutes": 90,
      "skills": [
        "Seller representation"
      ],
      "resources": [
        "Office 1",
        "Office 2"
      ]
    },
    {
      "name": "Seller phone consult",
      "description": "A first call about selling your home.",
      "minutes": 30,
      "skills": [
        "Seller representation"
      ],
      "resources": [
        "Phone Line 1",
        "Phone Line 2"
      ]
    },
    {
      "name": "Intro call",
      "description": "A quick call to answer first questions about buying or selling.",
      "minutes": 15,
      "skills": [
        "Buyer representation"
      ],
      "resources": [
        "Phone Line 1",
        "Phone Line 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "How do I set up a showing?",
      "section": "Booking",
      "content": "Tell us which home you're interested in and a few times that work, and we'll book a showing with an agent."
    },
    {
      "title": "Should I meet with an agent before looking at homes?",
      "section": "Service",
      "content": "Many buyers start with a buyer consult to talk about what they want and how the process works."
    },
    {
      "title": "What should I bring to a buyer consult?",
      "section": "Visit",
      "content": "Bring your list of must-haves and any pre-approval letter if you have one. It's fine if you don't have one yet."
    },
    {
      "title": "Can I talk to someone about selling my home?",
      "section": "Service",
      "content": "Yes. We can book a call or a listing appointment with an agent."
    }
  ]
}$spec$::jsonb
);

-- Spa & Wellness Template (spa → spa)
-- Research sources:
--   https://en.wikipedia.org/wiki/Day_spa
--   https://julepdayspa.com/day-spa-massage-facial-and-packages-menu/
--   https://spaviadayspa.com/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a027', 'Spa & Wellness Template', 'spa', 'spa',
  $spec${
  "skills": [
    {
      "name": "Massage",
      "description": "Relaxation and Swedish massage."
    },
    {
      "name": "Advanced massage",
      "description": "Deep tissue and hot stone massage."
    },
    {
      "name": "Facials",
      "description": "Skin care facials."
    },
    {
      "name": "Body treatments",
      "description": "Scrubs and wraps for the body."
    }
  ],
  "resources": [
    {
      "name": "Treatment Room 1",
      "description": "A private treatment room with a table."
    },
    {
      "name": "Treatment Room 2",
      "description": "A private treatment room with a table."
    }
  ],
  "staff": [
    {
      "name": "Therapist 1",
      "skills": [
        "Massage",
        "Advanced massage",
        "Facials",
        "Body treatments"
      ]
    },
    {
      "name": "Therapist 2",
      "skills": [
        "Massage",
        "Facials"
      ]
    }
  ],
  "services": [
    {
      "name": "Massage",
      "description": "A 60-minute relaxation massage.",
      "minutes": 60,
      "skills": [
        "Massage"
      ],
      "resources": [
        "Treatment Room 1",
        "Treatment Room 2"
      ]
    },
    {
      "name": "Extended massage",
      "description": "A 90-minute relaxation massage.",
      "minutes": 90,
      "skills": [
        "Massage"
      ],
      "resources": [
        "Treatment Room 1",
        "Treatment Room 2"
      ]
    },
    {
      "name": "Deep tissue massage",
      "description": "A firmer massage focused on tight areas.",
      "minutes": 60,
      "skills": [
        "Massage",
        "Advanced massage"
      ],
      "resources": [
        "Treatment Room 1",
        "Treatment Room 2"
      ]
    },
    {
      "name": "Hot stone massage",
      "description": "A massage using warm stones.",
      "minutes": 90,
      "skills": [
        "Massage",
        "Advanced massage"
      ],
      "resources": [
        "Treatment Room 1",
        "Treatment Room 2"
      ]
    },
    {
      "name": "Facial",
      "description": "Cleansing, exfoliation, mask and moisturizer, customized to your skin.",
      "minutes": 60,
      "skills": [
        "Facials"
      ],
      "resources": [
        "Treatment Room 1",
        "Treatment Room 2"
      ]
    },
    {
      "name": "Body scrub",
      "description": "Full-body exfoliation to leave skin smooth.",
      "minutes": 45,
      "skills": [
        "Body treatments"
      ],
      "resources": [
        "Treatment Room 1",
        "Treatment Room 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "How early should I arrive?",
      "section": "Visit",
      "content": "Please arrive about 10 to 15 minutes before your appointment so you can check in and settle in without cutting into your treatment time."
    },
    {
      "title": "Can I request a specific therapist?",
      "section": "Booking",
      "content": "Yes. Tell us who you would like when you book and we will schedule you with them if they are available."
    },
    {
      "title": "Do you offer gift cards?",
      "section": "Service",
      "content": "Ask us about gift cards when you call and we can tell you what we currently offer."
    },
    {
      "title": "What is your cancellation policy?",
      "section": "Policies",
      "content": "Please give us as much notice as you can if you need to cancel or reschedule, so we can offer the time to another guest."
    }
  ]
}$spec$::jsonb
);

-- Tax Preparation Template (tax-prep → tax_prep)
-- Research sources:
--   https://www.hrblock.com/tax-offices/drop-off/
--   https://www.hrblock.com/tax-appointment-preparation/
--   https://www.taxoutreach.org/blog/what-to-bring-to-a-tax-appointment-tax-checklist/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a028', 'Tax Preparation Template', 'tax-prep', 'tax_prep',
  $spec${
  "skills": [
    {
      "name": "Individual returns",
      "description": "Preparing personal tax returns."
    },
    {
      "name": "Business returns",
      "description": "Preparing returns for small businesses."
    },
    {
      "name": "Client intake",
      "description": "Collecting documents and client details."
    }
  ],
  "resources": [
    {
      "name": "Office 1",
      "description": "Main office for client appointments."
    },
    {
      "name": "Office 2",
      "description": "Second office for client appointments."
    },
    {
      "name": "Phone Line 1",
      "description": "For phone and video appointments."
    },
    {
      "name": "Phone Line 2",
      "description": "For phone and video appointments."
    }
  ],
  "staff": [
    {
      "name": "Preparer 1",
      "skills": [
        "Individual returns",
        "Business returns",
        "Client intake"
      ]
    },
    {
      "name": "Preparer 2",
      "skills": [
        "Individual returns",
        "Client intake"
      ]
    }
  ],
  "services": [
    {
      "name": "Tax consultation",
      "description": "Talk through your situation with a preparer.",
      "minutes": 30,
      "skills": [
        "Individual returns"
      ],
      "resources": [
        "Office 1",
        "Office 2",
        "Phone Line 1",
        "Phone Line 2"
      ]
    },
    {
      "name": "Individual return drop-off",
      "description": "Drop off your documents and go over a short checklist.",
      "minutes": 15,
      "skills": [
        "Client intake"
      ],
      "resources": [
        "Office 1",
        "Office 2"
      ]
    },
    {
      "name": "Individual return appointment",
      "description": "Sit down with a preparer to work on your return.",
      "minutes": 60,
      "skills": [
        "Individual returns"
      ],
      "resources": [
        "Office 1",
        "Office 2"
      ]
    },
    {
      "name": "Business return appointment",
      "description": "Meet about a small business return.",
      "minutes": 90,
      "skills": [
        "Business returns"
      ],
      "resources": [
        "Office 1"
      ]
    },
    {
      "name": "Return review",
      "description": "Go over your finished return before it is filed.",
      "minutes": 30,
      "skills": [
        "Individual returns"
      ],
      "resources": [
        "Office 1",
        "Office 2",
        "Phone Line 1",
        "Phone Line 2"
      ]
    },
    {
      "name": "Tax letter review",
      "description": "Bring in a letter you received so a preparer can look at it.",
      "minutes": 30,
      "skills": [
        "Individual returns"
      ],
      "resources": [
        "Office 1",
        "Phone Line 1",
        "Phone Line 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "What should I bring to my appointment?",
      "section": "Visit",
      "content": "Bring a photo ID, Social Security numbers for everyone on the return, your tax forms from the year, and last year's return if you're new to us."
    },
    {
      "title": "Can I just drop off my documents?",
      "section": "Booking",
      "content": "Yes. We can book a short drop-off appointment where we go over your documents with you."
    },
    {
      "title": "Can you tell me what I'll get back or owe?",
      "section": "Policies",
      "content": "We can't answer that on this call. A preparer will go over your situation during your appointment."
    },
    {
      "title": "I got a letter about my taxes. What should I do?",
      "section": "Service",
      "content": "Keep the letter and bring it with you. We can book a time for a preparer to look at it with you."
    }
  ]
}$spec$::jsonb
);

-- Tutoring Service Template (tutoring → tutoring)
-- Research sources:
--   https://www.tutoringcenter.com/
--   https://www.intellectconnecttutoring.com/service-page/free-academic-assessment
--   https://tutoring4less.com/free-assessment/
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a029', 'Tutoring Service Template', 'tutoring', 'tutoring',
  $spec${
  "skills": [
    {
      "name": "Math",
      "description": "Math tutoring across grade levels."
    },
    {
      "name": "Reading and writing",
      "description": "Reading, writing, and English help."
    },
    {
      "name": "Test prep",
      "description": "Preparing for standardized tests."
    },
    {
      "name": "Assessments",
      "description": "Checking where a student is before tutoring starts."
    },
    {
      "name": "General tutoring",
      "description": "Homework help and general subject support"
    }
  ],
  "resources": [
    {
      "name": "Room 1",
      "description": "Tutoring room."
    },
    {
      "name": "Room 2",
      "description": "Tutoring room."
    },
    {
      "name": "Online Room 1",
      "description": "For online sessions."
    },
    {
      "name": "Online Room 2",
      "description": "For online sessions."
    }
  ],
  "staff": [
    {
      "name": "Tutor 1",
      "skills": [
        "Math",
        "Reading and writing",
        "Test prep",
        "Assessments",
        "General tutoring"
      ]
    },
    {
      "name": "Tutor 2",
      "skills": [
        "Math",
        "Reading and writing",
        "General tutoring",
        "Assessments"
      ]
    }
  ],
  "services": [
    {
      "name": "Intro session",
      "description": "Meet the tutor, share goals, and see how a session works.",
      "minutes": 45,
      "skills": [
        "Assessments"
      ],
      "resources": [
        "Room 1",
        "Room 2",
        "Online Room 1",
        "Online Room 2"
      ]
    },
    {
      "name": "Tutoring session",
      "description": "A regular one-on-one tutoring session.",
      "minutes": 60,
      "skills": [
        "General tutoring"
      ],
      "resources": [
        "Room 1",
        "Room 2",
        "Online Room 1",
        "Online Room 2"
      ]
    },
    {
      "name": "Reading and writing session",
      "description": "One-on-one help with reading or writing.",
      "minutes": 60,
      "skills": [
        "Reading and writing"
      ],
      "resources": [
        "Room 1",
        "Room 2",
        "Online Room 1",
        "Online Room 2"
      ]
    },
    {
      "name": "Homework help",
      "description": "A shorter session for homework questions.",
      "minutes": 30,
      "skills": [
        "General tutoring"
      ],
      "resources": [
        "Room 1",
        "Room 2",
        "Online Room 1",
        "Online Room 2"
      ]
    },
    {
      "name": "Test prep session",
      "description": "A focused session preparing for a test.",
      "minutes": 90,
      "skills": [
        "Test prep"
      ],
      "resources": [
        "Room 1",
        "Online Room 1",
        "Online Room 2"
      ]
    },
    {
      "name": "Parent check-in",
      "description": "A short meeting with a parent about progress.",
      "minutes": 15,
      "skills": [
        "Assessments"
      ],
      "resources": [
        "Room 1",
        "Online Room 1",
        "Online Room 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "How do we get started?",
      "section": "Booking",
      "content": "Most families start with an intro session so the tutor can learn the student's goals and where they are."
    },
    {
      "title": "Do you offer online sessions?",
      "section": "Visit",
      "content": "Many of our sessions can be held online or in person. Let us know which you prefer when you book."
    },
    {
      "title": "What should my student bring?",
      "section": "Visit",
      "content": "Bring current schoolwork, homework, or recent tests, plus anything they usually write with or use in class."
    },
    {
      "title": "Can a parent stay during the session?",
      "section": "Policies",
      "content": "Parents are welcome to stay if the tutor agrees, and the tutor can share progress at the end of the session."
    }
  ]
}$spec$::jsonb
);

-- Yoga Studio Template (yoga-studio → yoga_studio)
-- Research sources:
--   https://www.corepoweryoga.com/content/first-timers-studio
--   https://www.gaiam.com/blogs/discover/off-the-couch-and-onto-the-mat-what-to-expect-from-your-first-yoga-class
--   https://www.huggermugger.com/blogs/yoga-gear/do-i-need-to-bring-my-own-mat-to-yoga
SELECT seed_business_template(
  '7e3a0000-0000-4000-8000-00000000a030', 'Yoga Studio Template', 'yoga-studio', 'yoga_studio',
  $spec${
  "skills": [
    {
      "name": "Group classes",
      "description": "Leading group yoga classes."
    },
    {
      "name": "Private instruction",
      "description": "One-on-one yoga sessions."
    },
    {
      "name": "Meditation",
      "description": "Guided meditation and breathwork."
    }
  ],
  "resources": [
    {
      "name": "Studio 1",
      "description": "The main practice room."
    },
    {
      "name": "Studio 2",
      "description": "A smaller room for private sessions and small classes."
    }
  ],
  "staff": [
    {
      "name": "Instructor 1",
      "skills": [
        "Group classes",
        "Private instruction",
        "Meditation"
      ]
    },
    {
      "name": "Instructor 2",
      "skills": [
        "Group classes"
      ]
    }
  ],
  "services": [
    {
      "name": "Class drop-in",
      "description": "A single spot in a regular group class.",
      "minutes": 60,
      "skills": [
        "Group classes"
      ],
      "resources": [
        "Studio 1",
        "Studio 2"
      ]
    },
    {
      "name": "Beginner class",
      "description": "A slower group class that covers the basics.",
      "minutes": 60,
      "skills": [
        "Group classes"
      ],
      "resources": [
        "Studio 1",
        "Studio 2"
      ]
    },
    {
      "name": "Extended class",
      "description": "A longer group class with more time for each pose.",
      "minutes": 90,
      "skills": [
        "Group classes"
      ],
      "resources": [
        "Studio 1"
      ]
    },
    {
      "name": "Private session",
      "description": "A one-on-one session built around your goals.",
      "minutes": 60,
      "skills": [
        "Private instruction"
      ],
      "resources": [
        "Studio 1",
        "Studio 2"
      ]
    },
    {
      "name": "Guided meditation",
      "description": "A guided meditation and breathwork session.",
      "minutes": 30,
      "skills": [
        "Meditation"
      ],
      "resources": [
        "Studio 1",
        "Studio 2"
      ]
    }
  ],
  "docs": [
    {
      "title": "I've never done yoga. Which class should I take?",
      "section": "Booking",
      "content": "A beginner class is a good place to start. Let the instructor know it is your first class and they will help you along."
    },
    {
      "title": "What should I bring?",
      "section": "Visit",
      "content": "Wear comfortable clothes you can move in and bring water. If you have a mat, bring it; if not, ask us about using a studio mat."
    },
    {
      "title": "How early should I arrive?",
      "section": "Visit",
      "content": "Please arrive about 10 to 15 minutes early, especially for your first class, so you can check in and get settled."
    },
    {
      "title": "Do you offer private sessions?",
      "section": "Service",
      "content": "Yes. A private session is one-on-one with an instructor and is tailored to what you want to work on."
    }
  ]
}$spec$::jsonb
);

SELECT set_config('app.template_maintenance', 'off', true);
