/**
 * VERTICAL INTAKE TREES - slot-filling intake for 30 business verticals.
 *
 * Each tree is a small, composable intake that a vertical's front-desk preset
 * selects ALONGSIDE booking/message: the caller states what they need and the
 * tree captures the structured details the owner wants attached to the visit.
 *
 * WHY THESE HAVE NO ACTION NODE. An intake tree does not write on its own - its
 * answers ride into the partner block's write (a booked appointment or a
 * message), exactly like `fix_computer` and `buy_service`. So every intake
 * block declares `sink: 'composed'` and names its carriers in `pairs_with`
 * (blockContract.test.ts enforces both). The durable outcome is the booking.
 *
 * NODE IDS ARE VERTICAL-PREFIXED so the whole platform library merges through
 * the tracker without two verticals colliding on a shared id (trees.test.ts
 * constructs a tracker over every tree at once).
 *
 * LISTEN-ONLY NODES (`listen: true`) are never asked - they are caught only if
 * the caller volunteers them - so an intake never holds the goodbye gate open
 * on a detail nobody needs to ask for. The one or two nodes a vertical truly
 * needs are plain text/choice; the rest listen.
 *
 * HIPAA-dependent verticals (dentist, chiropractor, vet clinic) are DELIBERATELY
 * excluded - see supabase/migrations/20260321000000_remove_hipaa_templates.sql.
 *
 * The ask text is written FOR THE MODEL (instructions, not a script read to the
 * caller).
 */
import type { QuestionTreeDef } from './types.js';
import type { ConversationBlockDef, VerticalPresetDef } from './blockTypes.js';

export const AUTO_SHOP_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'auto_shop_intake',
  description:
    'The caller needs vehicle repair or maintenance \u2014 a noise, a warning light, a service that is due, or work quoted. Select alongside booking so the visit lands with the vehicle and symptom already attached.',
  nodes: [
    {
      node_id: 'auto_shop_service_need',
      type: 'text',
      ask: "what the vehicle needs, in the caller's own words \u2014 the symptom, the noise, or the service they name. One open question usually gets it; record what they say and ask only for what is still missing.",
    },
    {
      node_id: 'auto_shop_vehicle_year',
      type: 'text',
      listen: true,
      ask: "the vehicle's model year, if they mention it.",
    },
    {
      node_id: 'auto_shop_vehicle_make',
      type: 'text',
      listen: true,
      ask: 'the make of the vehicle (Toyota, Ford, ...), if they say it.',
    },
    {
      node_id: 'auto_shop_vehicle_model',
      type: 'text',
      listen: true,
      ask: 'the model of the vehicle, if they say it.',
    },
    {
      node_id: 'auto_shop_vehicle_mileage',
      type: 'text',
      listen: true,
      ask: 'roughly how many miles are on it, if they mention it.',
    },
    {
      node_id: 'auto_shop_check_engine_light',
      type: 'text',
      listen: true,
      ask: 'whether a check-engine or warning light is on, if they bring it up.',
    },
    {
      node_id: 'auto_shop_prior_attempts',
      type: 'text',
      listen: true,
      ask: 'anything they have already tried or had looked at for this issue, if they say so.',
    },
  ],
};

export const MOBILE_TIRE_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'mobile_tire_intake',
  description:
    'The caller needs mobile tire help that comes to them \u2014 a flat, a replacement, a rotation, or a road-side change. Select alongside booking so the dispatch has the vehicle, the tire, and the location attached.',
  nodes: [
    {
      node_id: 'mobile_tire_situation',
      type: 'choice',
      ask: 'what the tire situation is \u2014 a flat needing help now, or a replacement or rotation they want scheduled.',
      options: {
        flat_now: [
          {
            node_id: 'mobile_tire_safe_location',
            type: 'text',
            ask: 'where the vehicle is and whether it is somewhere safe to work \u2014 a shoulder, a driveway, a parking lot.',
          },
          {
            node_id: 'mobile_tire_has_spare',
            type: 'text',
            listen: true,
            ask: 'whether they have a usable spare on hand, if they mention it.',
          },
        ],
        scheduled_service: [
          {
            node_id: 'mobile_tire_service_wanted',
            type: 'text',
            ask: 'what they want done \u2014 new tires, a rotation, a patch \u2014 in their own words.',
          },
          {
            node_id: 'mobile_tire_tire_count',
            type: 'text',
            listen: true,
            ask: 'how many tires this involves, if they say.',
          },
        ],
      },
    },
    {
      node_id: 'mobile_tire_vehicle_make_model',
      type: 'text',
      listen: true,
      ask: 'the make and model of the vehicle, if they mention it.',
    },
    {
      node_id: 'mobile_tire_tire_size',
      type: 'text',
      listen: true,
      ask: 'the tire size on the sidewall, if they happen to have it.',
    },
    {
      node_id: 'mobile_tire_service_location',
      type: 'text',
      listen: true,
      ask: 'the address or place the vehicle will be for the service, if given.',
    },
  ],
};

export const CAR_DETAILING_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'car_detailing_intake',
  description:
    "The caller wants their vehicle detailed or cleaned \u2014 interior, exterior, or a full detail. Select alongside booking so the appointment carries the package and the vehicle's condition.",
  nodes: [
    {
      node_id: 'car_detailing_package_interest',
      type: 'choice',
      ask: 'which detailing they want \u2014 interior only, exterior only, or a full detail.',
      options: {
        interior: [],
        exterior: [],
        full_detail: [],
      },
    },
    {
      node_id: 'car_detailing_vehicle_type',
      type: 'text',
      ask: 'what kind of vehicle it is \u2014 sedan, SUV, truck, van \u2014 since size drives the time and price.',
    },
    {
      node_id: 'car_detailing_condition_notes',
      type: 'text',
      listen: true,
      ask: 'anything about the current condition worth flagging \u2014 heavy dirt, spills, odor \u2014 if they mention it.',
    },
    {
      node_id: 'car_detailing_pet_hair',
      type: 'text',
      listen: true,
      ask: 'whether there is pet hair to deal with, if they say so.',
    },
    {
      node_id: 'car_detailing_stains',
      type: 'text',
      listen: true,
      ask: 'any specific stains or spots they want addressed, if named.',
    },
  ],
};

export const BODY_SHOP_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'body_shop_intake',
  description:
    'The caller has collision or body damage they want repaired or estimated. Select alongside booking so the estimate visit carries the damage description and any insurance claim.',
  nodes: [
    {
      node_id: 'body_shop_damage_description',
      type: 'text',
      ask: "what happened and what is damaged, in the caller's own words \u2014 the panels, the dents, the scrapes.",
    },
    {
      node_id: 'body_shop_insurance_claim',
      type: 'choice',
      ask: 'whether this is going through insurance or they are paying themselves.',
      options: {
        has_claim: [
          {
            node_id: 'body_shop_insurer_name',
            type: 'text',
            listen: true,
            ask: 'which insurance company, if they name it.',
          },
          {
            node_id: 'body_shop_claim_number',
            type: 'text',
            listen: true,
            ask: 'the claim number, if they have it handy.',
          },
        ],
        self_pay: [],
      },
    },
    {
      node_id: 'body_shop_accident_date',
      type: 'text',
      listen: true,
      ask: 'when the damage happened, if they mention it.',
    },
    {
      node_id: 'body_shop_vehicle_make_model',
      type: 'text',
      listen: true,
      ask: 'the make and model of the vehicle, if given.',
    },
    {
      node_id: 'body_shop_drivable',
      type: 'text',
      listen: true,
      ask: 'whether the vehicle is still drivable, if they say so.',
    },
  ],
};

export const OIL_CHANGE_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'oil_change_intake',
  description:
    'The caller wants an oil change or routine service. Select alongside booking so the quick-service slot carries the vehicle and the oil type.',
  nodes: [
    {
      node_id: 'oil_change_oil_type',
      type: 'choice',
      ask: 'what kind of oil service they want \u2014 conventional, synthetic blend, or full synthetic \u2014 or let them describe it.',
      options: {
        conventional: [],
        synthetic_blend: [],
        full_synthetic: [],
        not_sure: [],
      },
    },
    {
      node_id: 'oil_change_vehicle_make_model',
      type: 'text',
      listen: true,
      ask: 'the make and model of the vehicle, if they mention it.',
    },
    {
      node_id: 'oil_change_mileage',
      type: 'text',
      listen: true,
      ask: 'roughly the current mileage, if they say it.',
    },
    {
      node_id: 'oil_change_last_change',
      type: 'text',
      listen: true,
      ask: 'when the last oil change was, if they recall.',
    },
    {
      node_id: 'oil_change_add_ons',
      type: 'text',
      listen: true,
      ask: 'any add-ons they ask about \u2014 filters, fluids, a tire rotation \u2014 if raised.',
    },
  ],
};

export const CAR_WASH_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'car_wash_intake',
  description:
    'The caller wants a car wash or wash package, or is asking about a membership. Select alongside booking or a message so the request carries the package and vehicle.',
  nodes: [
    {
      node_id: 'car_wash_wash_package',
      type: 'choice',
      ask: 'which wash they want \u2014 a basic wash, a deluxe wash, or a full detail package.',
      options: {
        basic: [],
        deluxe: [],
        full_detail: [],
      },
    },
    {
      node_id: 'car_wash_vehicle_type',
      type: 'text',
      ask: 'what kind of vehicle it is \u2014 car, SUV, truck \u2014 since larger vehicles change the price.',
    },
    {
      node_id: 'car_wash_membership_interest',
      type: 'text',
      listen: true,
      ask: 'whether they are interested in a monthly membership, if they bring it up.',
    },
    {
      node_id: 'car_wash_add_ons',
      type: 'text',
      listen: true,
      ask: 'any add-ons they mention \u2014 wax, interior vacuum, tire shine.',
    },
  ],
};

export const SALON_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'salon_intake',
  description:
    'The caller wants a hair-salon service \u2014 a cut, color, style, or treatment. Select alongside booking so the appointment carries the service and any stylist preference.',
  nodes: [
    {
      node_id: 'salon_service_request',
      type: 'text',
      ask: 'what they want done, in their own words \u2014 a trim, a full color, highlights, a blowout, a treatment.',
    },
    {
      node_id: 'salon_color_service',
      type: 'choice',
      ask: 'whether the visit includes a color service, since color needs more chair time.',
      options: {
        includes_color: [
          {
            node_id: 'salon_color_type',
            type: 'text',
            listen: true,
            ask: 'what kind of color \u2014 all-over, highlights, balayage, root touch-up \u2014 if they say.',
          },
        ],
        no_color: [],
      },
    },
    {
      node_id: 'salon_stylist_preference',
      type: 'text',
      listen: true,
      ask: 'whether they want a particular stylist, if they name one.',
    },
    {
      node_id: 'salon_hair_length',
      type: 'text',
      listen: true,
      ask: 'their current hair length, if they mention it.',
    },
    {
      node_id: 'salon_last_visit',
      type: 'text',
      listen: true,
      ask: 'when they were last in or last had this service, if they say.',
    },
  ],
};

export const BARBERSHOP_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'barbershop_intake',
  description:
    'The caller wants a barbershop service \u2014 a haircut, a beard trim, a shave, or a combination. Select alongside booking so the chair time carries the service and any barber preference.',
  nodes: [
    {
      node_id: 'barbershop_service_type',
      type: 'choice',
      ask: 'what they want \u2014 a haircut, a haircut with beard work, or beard-only service.',
      options: {
        haircut: [],
        haircut_and_beard: [],
        beard_only: [],
        other: [],
      },
    },
    {
      node_id: 'barbershop_barber_preference',
      type: 'text',
      listen: true,
      ask: 'whether they want a specific barber, if they name one.',
    },
    {
      node_id: 'barbershop_style_notes',
      type: 'text',
      listen: true,
      ask: 'any details about the style they want \u2014 a fade, a length, a number \u2014 if they give them.',
    },
    {
      node_id: 'barbershop_first_visit',
      type: 'text',
      listen: true,
      ask: 'whether this is their first visit, if they mention it.',
    },
  ],
};

export const NAIL_SALON_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'nail_salon_intake',
  description:
    'The caller wants a nail service \u2014 a manicure, pedicure, gel, or nail art. Select alongside booking so the appointment carries the service and any technician preference.',
  nodes: [
    {
      node_id: 'nail_salon_service_type',
      type: 'choice',
      ask: 'which service they want \u2014 a manicure, a pedicure, both, or something else.',
      options: {
        manicure: [],
        pedicure: [],
        both: [],
        other: [],
      },
    },
    {
      node_id: 'nail_salon_gel_or_regular',
      type: 'text',
      listen: true,
      ask: 'whether they want gel, dip, acrylic, or regular polish, if they say.',
    },
    {
      node_id: 'nail_salon_design_request',
      type: 'text',
      listen: true,
      ask: 'any nail art or design they want, if they describe it.',
    },
    {
      node_id: 'nail_salon_technician_preference',
      type: 'text',
      listen: true,
      ask: 'whether they want a particular technician, if they name one.',
    },
    {
      node_id: 'nail_salon_occasion',
      type: 'text',
      listen: true,
      ask: 'any occasion driving the visit \u2014 a wedding, an event \u2014 if they mention it.',
    },
  ],
};

export const SPA_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'spa_intake',
  description:
    'The caller wants a day-spa service \u2014 a massage, a facial, or a package. Select alongside booking so the treatment slot carries the service and any preferences.',
  nodes: [
    {
      node_id: 'spa_service_category',
      type: 'choice',
      ask: 'which treatment they want \u2014 a massage, a facial, or a package of services.',
      options: {
        massage: [
          {
            node_id: 'spa_massage_type',
            type: 'text',
            listen: true,
            ask: 'what kind of massage \u2014 Swedish, deep tissue, hot stone \u2014 if they say.',
          },
        ],
        facial: [],
        package: [],
        other: [],
      },
    },
    {
      node_id: 'spa_therapist_preference',
      type: 'text',
      listen: true,
      ask: 'whether they want a particular therapist, or a preference on gender, if raised.',
    },
    {
      node_id: 'spa_pressure_preference',
      type: 'text',
      listen: true,
      ask: 'any pressure preference for a massage \u2014 light, medium, firm \u2014 if mentioned.',
    },
    {
      node_id: 'spa_special_considerations',
      type: 'text',
      listen: true,
      // Comfort only (2026-09-25): "comfort or safety" invited callers to name
      // medical conditions — health information this product does not collect.
      ask:
        'anything they want the therapist to know for comfort \u2014 areas to focus on or avoid, ' +
        'room temperature \u2014 if they volunteer it. Never ask about or record medical ' +
        'conditions, medications or pregnancy; if the caller raises one, say the therapist ' +
        'will go over it with them in person.',
    },
  ],
};

export const MED_SPA_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'med_spa_intake',
  description:
    'The caller wants to book a consultation or aesthetic service at a med spa \u2014 injectables, laser, skincare. Select alongside booking so the consultation carries their area of interest. Never collect medical history on the call; that is for the provider.',
  nodes: [
    {
      node_id: 'med_spa_treatment_interest',
      type: 'text',
      ask: 'which service or treatment they are asking about, in their own words \u2014 record it to book the right consultation, and leave any medical detail for the provider.',
    },
    {
      node_id: 'med_spa_client_status',
      type: 'choice',
      ask: 'whether they are a new client or returning, since new clients start with a consultation.',
      options: {
        new_client: [],
        returning: [],
      },
    },
    {
      node_id: 'med_spa_area_of_interest',
      type: 'text',
      listen: true,
      ask: 'the area or concern they want addressed, if they describe it.',
    },
    {
      node_id: 'med_spa_event_date',
      type: 'text',
      listen: true,
      ask: 'any date they are preparing for, if they mention one.',
    },
    {
      node_id: 'med_spa_prior_treatments',
      type: 'text',
      listen: true,
      ask: 'whether they have had similar treatments before, only if they volunteer it.',
    },
  ],
};

export const LASH_STUDIO_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'lash_studio_intake',
  description:
    'The caller wants a lash service \u2014 a new set, a fill, or a removal. Select alongside booking so the appointment carries the service and the look they want.',
  nodes: [
    {
      node_id: 'lash_studio_service_type',
      type: 'choice',
      ask: 'which lash service they want \u2014 a new full set, a fill on existing lashes, or a removal.',
      options: {
        new_set: [
          {
            node_id: 'lash_studio_lash_style',
            type: 'text',
            listen: true,
            ask: 'the look they want \u2014 classic, hybrid, volume, natural \u2014 if they describe it.',
          },
        ],
        fill: [
          {
            node_id: 'lash_studio_last_appointment',
            type: 'text',
            listen: true,
            ask: 'when they last had a fill or set, since fills are time-sensitive, if they say.',
          },
        ],
        removal: [],
      },
    },
    {
      node_id: 'lash_studio_sensitivity',
      type: 'text',
      listen: true,
      ask: 'any sensitivity or reaction they have had before, only if they volunteer it.',
    },
    {
      node_id: 'lash_studio_first_visit',
      type: 'text',
      listen: true,
      ask: 'whether this is their first visit to the studio, if mentioned.',
    },
  ],
};

export const PLUMBER_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'plumber_intake',
  description:
    'The caller has a plumbing problem \u2014 a leak, a clog, a fixture, or an emergency. Lead with urgency, because a burst pipe cannot wait for a scheduled slot. Select alongside booking so the visit carries the problem and its urgency.',
  nodes: [
    {
      node_id: 'plumber_urgency',
      type: 'choice',
      ask: 'how urgent this is \u2014 an active emergency like a burst pipe or flooding, or a problem they want scheduled.',
      options: {
        emergency: [
          {
            node_id: 'plumber_emergency_details',
            type: 'text',
            ask: 'what is happening right now \u2014 where the water is coming from and how fast \u2014 so the right help is dispatched.',
          },
          {
            node_id: 'plumber_water_damage_present',
            type: 'text',
            ask: 'whether water is actively spreading or causing damage, and whether they have been able to shut off the water.',
          },
        ],
        scheduled: [
          {
            node_id: 'plumber_issue_type',
            type: 'text',
            ask: 'what needs work \u2014 a dripping faucet, a slow drain, a water heater, a running toilet \u2014 in their own words.',
          },
          {
            node_id: 'plumber_location_in_home',
            type: 'text',
            listen: true,
            ask: 'where in the home or building the problem is, if they say.',
          },
          {
            node_id: 'plumber_prior_attempts',
            type: 'text',
            listen: true,
            ask: 'anything they have already tried, if they mention it.',
          },
        ],
      },
    },
    {
      node_id: 'plumber_property_type',
      type: 'text',
      listen: true,
      ask: 'whether it is a house, apartment, or business, if they mention it.',
    },
  ],
};

export const ELECTRICIAN_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'electrician_intake',
  description:
    'The caller has an electrical problem or project \u2014 an outage, a hazard, a panel, or a wiring job. Lead with urgency, because sparks or a burning smell is a same-day dispatch. Select alongside booking.',
  nodes: [
    {
      node_id: 'electrician_urgency',
      type: 'choice',
      ask: 'how urgent this is \u2014 a hazard like sparks, a burning smell, or exposed wiring, versus work they want scheduled.',
      options: {
        hazard: [
          {
            node_id: 'electrician_hazard_details',
            type: 'text',
            ask: 'what they are seeing or smelling right now \u2014 sparks, smoke, a burning smell, an outlet that is hot \u2014 so the danger is understood before dispatch.',
          },
        ],
        scheduled: [
          {
            node_id: 'electrician_work_needed',
            type: 'text',
            ask: 'what electrical work they need \u2014 an outlet, a fixture, a panel upgrade, adding a circuit \u2014 in their own words.',
          },
        ],
      },
    },
    {
      node_id: 'electrician_property_type',
      type: 'text',
      listen: true,
      ask: 'whether it is a home, a rental, or a business, if mentioned.',
    },
    {
      node_id: 'electrician_panel_age',
      type: 'text',
      listen: true,
      ask: 'the age of the home or panel, if they bring it up.',
    },
    {
      node_id: 'electrician_permit_needed',
      type: 'text',
      listen: true,
      ask: 'whether they already know a permit is involved, only if they raise it.',
    },
  ],
};

export const HVAC_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'hvac_intake',
  description:
    'The caller has a heating or cooling problem, wants maintenance, or wants an install quote. Select alongside booking so the visit carries the system and the symptom.',
  nodes: [
    {
      node_id: 'hvac_system_issue',
      type: 'choice',
      ask: 'what they need \u2014 no heat, no cooling, routine maintenance, or a quote for a new system.',
      options: {
        no_heat: [],
        no_cooling: [],
        maintenance: [],
        install_quote: [],
      },
    },
    {
      node_id: 'hvac_problem_description',
      type: 'text',
      ask: 'what the system is doing or not doing, in their own words \u2014 record it so the tech arrives prepared.',
    },
    {
      node_id: 'hvac_system_type',
      type: 'text',
      listen: true,
      ask: 'the kind of system \u2014 central air, heat pump, furnace, mini-split \u2014 if they know it.',
    },
    {
      node_id: 'hvac_system_age',
      type: 'text',
      listen: true,
      ask: 'roughly how old the system is, if they say.',
    },
    {
      node_id: 'hvac_last_service',
      type: 'text',
      listen: true,
      ask: 'when it was last serviced, if they recall.',
    },
  ],
};

export const PEST_CONTROL_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'pest_control_intake',
  description:
    'The caller has a pest problem \u2014 insects, rodents, or another infestation. Select alongside booking so the treatment carries the pest and the severity.',
  nodes: [
    {
      node_id: 'pest_control_pest_type',
      type: 'text',
      ask: 'what pest they are dealing with, in their own words \u2014 ants, roaches, mice, wasps, bed bugs, termites.',
    },
    {
      node_id: 'pest_control_urgency',
      type: 'choice',
      ask: 'how pressing it is \u2014 an urgent situation like a wasp nest or a heavy infestation, versus routine prevention.',
      options: {
        urgent: [],
        routine: [],
      },
    },
    {
      node_id: 'pest_control_property_type',
      type: 'text',
      listen: true,
      ask: 'whether it is a home, apartment, or business, if mentioned.',
    },
    {
      node_id: 'pest_control_severity',
      type: 'text',
      listen: true,
      ask: 'how widespread it seems \u2014 one room or throughout \u2014 if they describe it.',
    },
    {
      node_id: 'pest_control_prior_treatment',
      type: 'text',
      listen: true,
      ask: 'whether they have treated for this before, if they say.',
    },
    {
      node_id: 'pest_control_indoor_outdoor',
      type: 'text',
      listen: true,
      ask: 'whether the problem is indoors, outdoors, or both, if noted.',
    },
  ],
};

export const CLEANING_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'cleaning_intake',
  description:
    'The caller wants cleaning service \u2014 a one-time clean, recurring service, a move-in or move-out, or a deep clean. Select alongside booking so the visit carries the property and the scope.',
  nodes: [
    {
      node_id: 'cleaning_cleaning_type',
      type: 'choice',
      ask: 'what kind of cleaning they want \u2014 a one-time clean, recurring service, a move-in/move-out clean, or a deep clean.',
      options: {
        one_time: [],
        recurring: [
          {
            node_id: 'cleaning_preferred_frequency',
            type: 'text',
            listen: true,
            ask: 'how often they want service \u2014 weekly, biweekly, monthly \u2014 if they say.',
          },
        ],
        move_in_out: [],
        deep_clean: [],
      },
    },
    {
      node_id: 'cleaning_property_details',
      type: 'text',
      ask: 'the size of the space \u2014 bedrooms and bathrooms, or square footage, or just how big it is \u2014 so the time can be estimated.',
    },
    {
      node_id: 'cleaning_pets',
      type: 'text',
      listen: true,
      ask: 'whether there are pets in the home, if they mention it.',
    },
    {
      node_id: 'cleaning_special_requests',
      type: 'text',
      listen: true,
      ask: 'any areas or tasks they especially want covered, if named.',
    },
  ],
};

export const LANDSCAPING_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'landscaping_intake',
  description:
    'The caller wants landscaping or yard work \u2014 mowing, cleanup, design, or a project. Select alongside booking so the estimate or service carries the property and the scope.',
  nodes: [
    {
      node_id: 'landscaping_service_request',
      type: 'text',
      ask: 'what they want done, in their own words \u2014 mowing, trimming, a cleanup, a new design, an install.',
    },
    {
      node_id: 'landscaping_service_kind',
      type: 'choice',
      ask: 'whether this is ongoing maintenance or a one-time project.',
      options: {
        maintenance: [
          {
            node_id: 'landscaping_frequency',
            type: 'text',
            listen: true,
            ask: 'how often they want service \u2014 weekly, biweekly, monthly \u2014 if they say.',
          },
        ],
        one_time_project: [
          {
            node_id: 'landscaping_project_scope',
            type: 'text',
            listen: true,
            ask: 'the scope of the project \u2014 a patio, plantings, sod, a wall \u2014 if they describe it.',
          },
        ],
      },
    },
    {
      node_id: 'landscaping_property_size',
      type: 'text',
      listen: true,
      ask: 'the size of the property or yard, if they mention it.',
    },
    {
      node_id: 'landscaping_project_timeline',
      type: 'text',
      listen: true,
      ask: 'any timeline they have in mind, if they say.',
    },
  ],
};

export const GARAGE_DOOR_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'garage_door_intake',
  description:
    'The caller has a garage-door problem or wants a new door or opener. Select alongside booking so the visit carries the symptom and the door details.',
  nodes: [
    {
      node_id: 'garage_door_issue_type',
      type: 'choice',
      ask: 'what is going on \u2014 the door will not open, a broken spring, off the track, a new install, or maintenance.',
      options: {
        wont_open: [],
        broken_spring: [],
        off_track: [],
        new_install: [],
        maintenance: [],
      },
    },
    {
      node_id: 'garage_door_problem_description',
      type: 'text',
      ask: 'what the door is doing, in their own words \u2014 the noise, the stall, the damage.',
    },
    {
      node_id: 'garage_door_door_material',
      type: 'text',
      listen: true,
      ask: 'the door material or type, if they know it.',
    },
    {
      node_id: 'garage_door_opener_brand',
      type: 'text',
      listen: true,
      ask: 'the opener brand, if they mention it.',
    },
  ],
};

export const LOCKSMITH_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'locksmith_intake',
  description:
    'The caller is locked out or needs lock work \u2014 a lockout, a rekey, or a new install. Lockouts are urgent and need a dispatch location. Select alongside booking or dispatch.',
  nodes: [
    {
      node_id: 'locksmith_situation',
      type: 'choice',
      ask: 'whether they are locked out right now, or want rekey or lock-install work scheduled.',
      options: {
        lockout: [
          {
            node_id: 'locksmith_lockout_location',
            type: 'text',
            ask: 'exactly where they are so someone can be sent \u2014 the address, and whether it is a car, a home, or a business.',
          },
          {
            node_id: 'locksmith_locked_out_of',
            type: 'text',
            listen: true,
            ask: 'what they are locked out of \u2014 a car, a house, an office \u2014 if not already clear.',
          },
        ],
        rekey_or_install: [
          {
            node_id: 'locksmith_work_needed',
            type: 'text',
            ask: 'what lock work they need \u2014 a rekey, new locks, a deadbolt, a smart lock \u2014 in their own words.',
          },
        ],
      },
    },
    {
      node_id: 'locksmith_key_type',
      type: 'text',
      listen: true,
      ask: 'any key or lock detail they give \u2014 a brand, a car with a chip key, a high-security lock.',
    },
    {
      node_id: 'locksmith_timeframe',
      type: 'text',
      listen: true,
      ask: 'when they need it done, if they say.',
    },
  ],
};

export const PERSONAL_TRAINER_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'personal_trainer_intake',
  description:
    'The caller wants personal training \u2014 a session, a program, or a consultation. Select alongside booking so the first session carries their goals and any limitations.',
  nodes: [
    {
      node_id: 'personal_trainer_fitness_goals',
      type: 'text',
      ask: 'what they want to achieve, in their own words \u2014 weight loss, strength, mobility, sport-specific, general health.',
    },
    {
      node_id: 'personal_trainer_session_type',
      type: 'choice',
      ask: 'what they are after \u2014 one-on-one training, group sessions, or a consultation first.',
      options: {
        one_on_one: [],
        group: [],
        consultation: [],
      },
    },
    {
      node_id: 'personal_trainer_experience_level',
      type: 'text',
      listen: true,
      ask: 'their training experience \u2014 new, returning, experienced \u2014 if they say.',
    },
    // No injuries/limitations node (removed 2026-09-25): health information is
    // for the trainer to discuss in person, not for the phone line to record.
    {
      node_id: 'personal_trainer_schedule_preference',
      type: 'text',
      listen: true,
      ask: 'the days or times that work for them, if mentioned.',
    },
    {
      node_id: 'personal_trainer_in_person_or_virtual',
      type: 'text',
      listen: true,
      ask: 'whether they want in-person or virtual training, if noted.',
    },
  ],
};

export const YOGA_STUDIO_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'yoga_studio_intake',
  description:
    'The caller is asking about yoga classes, memberships, private sessions, or workshops. Select alongside booking or a message so the request carries their interest and experience.',
  nodes: [
    {
      node_id: 'yoga_studio_interest',
      type: 'choice',
      ask: 'what they want \u2014 to drop in on a class, a membership, a private session, or a workshop.',
      options: {
        drop_in: [],
        membership: [],
        private_session: [],
        workshop: [],
      },
    },
    {
      node_id: 'yoga_studio_experience_level',
      type: 'text',
      listen: true,
      ask: 'their yoga experience \u2014 brand new, some, experienced \u2014 if they say.',
    },
    {
      node_id: 'yoga_studio_class_style_preference',
      type: 'text',
      listen: true,
      ask: 'any style they prefer \u2014 vinyasa, hot, restorative, hatha \u2014 if mentioned.',
    },
    {
      node_id: 'yoga_studio_schedule_preference',
      type: 'text',
      listen: true,
      ask: 'the days or times that work for them, if noted.',
    },
    {
      node_id: 'yoga_studio_goals',
      type: 'text',
      listen: true,
      ask: 'what they hope to get from it \u2014 flexibility, stress, strength \u2014 if they volunteer it.',
    },
  ],
};

export const TAX_PREP_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'tax_prep_intake',
  description:
    'The caller needs tax preparation or filing help \u2014 personal or business. Select alongside booking so the appointment carries the filing type and the year.',
  nodes: [
    {
      node_id: 'tax_prep_filing_type',
      type: 'choice',
      ask: 'what kind of return this is \u2014 an individual return, a business return, or something else.',
      options: {
        individual: [
          {
            node_id: 'tax_prep_life_changes',
            type: 'text',
            listen: true,
            ask: 'any major changes this year \u2014 marriage, a home, a new dependent, a move \u2014 if they mention it.',
          },
        ],
        business: [
          {
            node_id: 'tax_prep_business_structure',
            type: 'text',
            ask: 'the business structure \u2014 sole proprietor, LLC, S-corp, partnership \u2014 in their own words.',
          },
        ],
        other: [],
      },
    },
    {
      node_id: 'tax_prep_tax_year',
      type: 'text',
      listen: true,
      ask: 'which tax year this is for, if they specify.',
    },
    {
      node_id: 'tax_prep_prior_preparer',
      type: 'text',
      listen: true,
      ask: 'whether they had someone prepare it before, if they say.',
    },
    {
      node_id: 'tax_prep_documents_ready',
      type: 'text',
      listen: true,
      ask: 'whether they already have their documents together, if mentioned.',
    },
    {
      node_id: 'tax_prep_deadline_pressure',
      type: 'text',
      listen: true,
      ask: 'any deadline they are up against \u2014 an extension, a notice \u2014 if they raise it.',
    },
  ],
};

export const TUTORING_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'tutoring_intake',
  description:
    'The caller wants tutoring \u2014 for a K-12 student, a college student, or an adult learner. Select alongside booking so the first session carries the subject and the goals.',
  nodes: [
    {
      node_id: 'tutoring_subject_needed',
      type: 'text',
      ask: 'what subject or skill they need help with, in their own words \u2014 math, reading, a test, a language.',
    },
    {
      node_id: 'tutoring_student_type',
      type: 'choice',
      ask: 'who the tutoring is for \u2014 a K-12 student, a college student, or an adult learner.',
      options: {
        k12_student: [
          {
            node_id: 'tutoring_grade_level',
            type: 'text',
            listen: true,
            ask: "the student's grade level, if they say.",
          },
        ],
        college: [],
        adult_learner: [],
      },
    },
    {
      node_id: 'tutoring_current_challenges',
      type: 'text',
      listen: true,
      ask: 'what they are struggling with specifically, if they describe it.',
    },
    {
      node_id: 'tutoring_schedule_preference',
      type: 'text',
      listen: true,
      ask: 'the days or times that work, if mentioned.',
    },
    {
      node_id: 'tutoring_in_person_or_online',
      type: 'text',
      listen: true,
      ask: 'whether they want in-person or online tutoring, if noted.',
    },
  ],
};

export const PHOTOGRAPHY_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'photography_intake',
  description:
    'The caller wants photography \u2014 a wedding, portraits, an event, or commercial work. Select alongside booking so the consultation carries the shoot type and the date.',
  nodes: [
    {
      node_id: 'photography_shoot_type',
      type: 'choice',
      ask: 'what kind of shoot they want \u2014 a wedding, portraits, an event, commercial work, or something else.',
      options: {
        wedding: [],
        portrait: [],
        event: [],
        commercial: [],
        other: [],
      },
    },
    {
      node_id: 'photography_event_details',
      type: 'text',
      ask: 'the details of the shoot, in their own words \u2014 what it is for and what they picture.',
    },
    {
      node_id: 'photography_event_date',
      type: 'text',
      listen: true,
      ask: 'the date they have in mind, if they give one.',
    },
    {
      node_id: 'photography_location',
      type: 'text',
      listen: true,
      ask: 'where the shoot would be, if they mention it.',
    },
    {
      node_id: 'photography_hours_needed',
      type: 'text',
      listen: true,
      ask: 'roughly how much coverage they want, if they say.',
    },
    {
      node_id: 'photography_budget_range',
      type: 'text',
      listen: true,
      ask: 'any budget they mention, only if they volunteer it.',
    },
  ],
};

export const REAL_ESTATE_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'real_estate_intake',
  description:
    'The caller is a prospective buyer, seller, or renter working with a real-estate agent. Select alongside booking so the consultation carries what they are trying to do.',
  nodes: [
    {
      node_id: 'real_estate_interest_type',
      type: 'choice',
      ask: 'what they are trying to do \u2014 buy, sell, or rent.',
      options: {
        buying: [
          {
            node_id: 'real_estate_budget',
            type: 'text',
            listen: true,
            ask: 'their budget or price range, only if they volunteer it.',
          },
          {
            node_id: 'real_estate_preferred_area',
            type: 'text',
            listen: true,
            ask: 'the areas or neighborhoods they are interested in, if they say.',
          },
          {
            node_id: 'real_estate_property_type',
            type: 'text',
            listen: true,
            ask: 'the kind of property \u2014 house, condo, land \u2014 if mentioned.',
          },
          {
            node_id: 'real_estate_timeline',
            type: 'text',
            listen: true,
            ask: 'their timeline for buying, if they give one.',
          },
        ],
        selling: [
          {
            node_id: 'real_estate_property_address',
            type: 'text',
            listen: true,
            ask: 'the address or area of the property they want to sell, if they say.',
          },
          {
            node_id: 'real_estate_reason_for_selling',
            type: 'text',
            listen: true,
            ask: 'why they are selling, only if they volunteer it.',
          },
          {
            node_id: 'real_estate_timeline',
            type: 'text',
            listen: true,
            ask: 'their timeline for selling, if they give one.',
          },
        ],
        renting: [
          {
            node_id: 'real_estate_budget',
            type: 'text',
            listen: true,
            ask: 'their monthly budget, only if they volunteer it.',
          },
          {
            node_id: 'real_estate_preferred_area',
            type: 'text',
            listen: true,
            ask: 'the areas they want to rent in, if they say.',
          },
          {
            node_id: 'real_estate_move_date',
            type: 'text',
            listen: true,
            ask: 'when they need to move, if they mention it.',
          },
        ],
      },
    },
    {
      node_id: 'real_estate_financing_status',
      type: 'text',
      listen: true,
      ask: 'whether they are pre-approved or paying cash, only if they raise it.',
    },
  ],
};

export const INSURANCE_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'insurance_intake',
  description:
    'The caller wants an insurance quote, has a policy question, or is asking about a claim. Select alongside booking or a message so the request carries the coverage type. Never quote or give coverage advice on the call; capture it for a licensed agent.',
  nodes: [
    {
      node_id: 'insurance_insurance_interest',
      type: 'choice',
      ask: 'what they need \u2014 a new quote, a question about an existing policy, or help with a claim.',
      options: {
        new_quote: [
          {
            node_id: 'insurance_coverage_type',
            type: 'text',
            ask: 'what kind of coverage they want quoted \u2014 auto, home, life, renters, business \u2014 in their own words.',
          },
        ],
        existing_policy: [
          {
            node_id: 'insurance_policy_number',
            type: 'text',
            listen: true,
            ask: 'their policy number, if they have it handy.',
          },
        ],
        claim_question: [
          {
            node_id: 'insurance_claim_details',
            type: 'text',
            ask: 'what the claim is about, in their own words, so the agent can follow up \u2014 do not advise on it.',
          },
        ],
      },
    },
    {
      node_id: 'insurance_current_provider',
      type: 'text',
      listen: true,
      ask: 'who they are insured with now, if they mention it.',
    },
    {
      node_id: 'insurance_coverage_needs',
      type: 'text',
      listen: true,
      ask: 'anything specific they want covered, if they describe it.',
    },
  ],
};

export const ANSWERING_SERVICE_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'answering_service_intake',
  description:
    'The caller is a business owner asking about answering-service or virtual-receptionist coverage for their own line. Select alongside booking or a message so the request carries their business and their needs.',
  nodes: [
    {
      node_id: 'answering_service_business_name_and_type',
      type: 'text',
      ask: "the caller's business \u2014 its name and what it does \u2014 since coverage is tailored to the kind of calls they get.",
    },
    {
      node_id: 'answering_service_interest',
      type: 'choice',
      ask: 'whether they are looking to start new service or are calling about an existing account.',
      options: {
        new_service: [],
        existing_account: [],
      },
    },
    {
      node_id: 'answering_service_call_volume',
      type: 'text',
      listen: true,
      ask: 'roughly how many calls a day they take, if they say.',
    },
    {
      node_id: 'answering_service_services_needed',
      type: 'text',
      listen: true,
      ask: 'what they want handled \u2014 booking, messages, order-taking, dispatch \u2014 if they describe it.',
    },
    {
      node_id: 'answering_service_hours_of_coverage',
      type: 'text',
      listen: true,
      ask: 'the hours they need covered \u2014 after-hours, 24/7, overflow \u2014 if mentioned.',
    },
  ],
};

export const BAKERY_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'bakery_intake',
  description:
    'The caller wants a bakery order \u2014 a custom cake, pastries, bread, or an order for an event. Select alongside booking or a message so the order carries the details and the date.',
  nodes: [
    {
      node_id: 'bakery_order_type',
      type: 'choice',
      ask: 'what they want to order \u2014 a custom cake, pastries, bread, or a larger order for an event.',
      options: {
        custom_cake: [
          {
            node_id: 'bakery_cake_details',
            type: 'text',
            listen: true,
            ask: 'the cake details \u2014 flavor, size, design, writing \u2014 if they describe them.',
          },
        ],
        pastries: [],
        bread: [],
        event_order: [],
      },
    },
    {
      node_id: 'bakery_order_details',
      type: 'text',
      ask: 'what they want, in their own words, and roughly how much \u2014 enough for the baker to price and plan.',
    },
    {
      node_id: 'bakery_event_date',
      type: 'text',
      listen: true,
      ask: 'the date they need it by, if they give one.',
    },
    {
      node_id: 'bakery_servings',
      type: 'text',
      listen: true,
      ask: 'how many people it needs to serve, if they say.',
    },
    {
      node_id: 'bakery_dietary_restrictions',
      type: 'text',
      listen: true,
      ask: 'any dietary needs \u2014 gluten-free, nut allergy, vegan \u2014 if they mention them.',
    },
    {
      node_id: 'bakery_pickup_or_delivery',
      type: 'text',
      listen: true,
      ask: 'whether they want pickup or delivery, if noted.',
    },
  ],
};

export const CATERING_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'catering_intake',
  description:
    'The caller wants catering for an event. Select alongside booking so the consultation carries the event, the date, and the head count.',
  nodes: [
    {
      node_id: 'catering_event_type',
      type: 'text',
      ask: 'what kind of event it is, in their own words \u2014 a wedding, a corporate lunch, a party, a funeral.',
    },
    {
      node_id: 'catering_event_date',
      type: 'text',
      listen: true,
      ask: 'the date of the event \u2014 record it exactly as they say it, even if approximate, whenever they mention it.',
    },
    {
      node_id: 'catering_guest_count',
      type: 'text',
      listen: true,
      ask: 'roughly how many guests \u2014 a number or a range is fine, never push for precision \u2014 if they say.',
    },
    {
      node_id: 'catering_meal_type',
      type: 'text',
      listen: true,
      ask: 'the kind of meal they want \u2014 buffet, plated, appetizers, drop-off \u2014 if they say.',
    },
    {
      node_id: 'catering_dietary_restrictions',
      type: 'text',
      listen: true,
      ask: 'any dietary needs across the guests \u2014 vegetarian, allergies, kosher, halal \u2014 if mentioned.',
    },
    {
      node_id: 'catering_service_style',
      type: 'text',
      listen: true,
      ask: 'whether they need full service, staff, or just the food delivered, if noted.',
    },
    {
      node_id: 'catering_venue_location',
      type: 'text',
      listen: true,
      ask: 'where the event is, if they mention it.',
    },
    {
      node_id: 'catering_budget_range',
      type: 'text',
      listen: true,
      ask: 'any budget they mention, only if they volunteer it.',
    },
  ],
};

/** All 30 vertical intake trees, in canonical order. */
export const VERTICAL_INTAKE_TREES: QuestionTreeDef[] = [
  AUTO_SHOP_INTAKE_TREE,
  MOBILE_TIRE_INTAKE_TREE,
  CAR_DETAILING_INTAKE_TREE,
  BODY_SHOP_INTAKE_TREE,
  OIL_CHANGE_INTAKE_TREE,
  CAR_WASH_INTAKE_TREE,
  SALON_INTAKE_TREE,
  BARBERSHOP_INTAKE_TREE,
  NAIL_SALON_INTAKE_TREE,
  SPA_INTAKE_TREE,
  MED_SPA_INTAKE_TREE,
  LASH_STUDIO_INTAKE_TREE,
  PLUMBER_INTAKE_TREE,
  ELECTRICIAN_INTAKE_TREE,
  HVAC_INTAKE_TREE,
  PEST_CONTROL_INTAKE_TREE,
  CLEANING_INTAKE_TREE,
  LANDSCAPING_INTAKE_TREE,
  GARAGE_DOOR_INTAKE_TREE,
  LOCKSMITH_INTAKE_TREE,
  PERSONAL_TRAINER_INTAKE_TREE,
  YOGA_STUDIO_INTAKE_TREE,
  TAX_PREP_INTAKE_TREE,
  TUTORING_INTAKE_TREE,
  PHOTOGRAPHY_INTAKE_TREE,
  REAL_ESTATE_INTAKE_TREE,
  INSURANCE_INTAKE_TREE,
  ANSWERING_SERVICE_INTAKE_TREE,
  BAKERY_INTAKE_TREE,
  CATERING_INTAKE_TREE,
];

/**
 * One conversation block per vertical intake. Composed sink: the answers ride
 * into a booking or a message. pairs_with names the carriers so the block
 * contract can verify someone does the writing.
 */
export const VERTICAL_INTAKE_BLOCKS: Record<string, ConversationBlockDef> = {
  auto_shop_intake: {
    block_id: 'auto_shop_intake',
    kind: 'conversation',
    description:
      'Auto shop intake - captures service details that ride into the booking or message.',
    tree_refs: ['auto_shop_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  mobile_tire_intake: {
    block_id: 'mobile_tire_intake',
    kind: 'conversation',
    description:
      'Mobile tire intake - captures service details that ride into the booking or message.',
    tree_refs: ['mobile_tire_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  car_detailing_intake: {
    block_id: 'car_detailing_intake',
    kind: 'conversation',
    description:
      'Car detailing intake - captures service details that ride into the booking or message.',
    tree_refs: ['car_detailing_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  body_shop_intake: {
    block_id: 'body_shop_intake',
    kind: 'conversation',
    description:
      'Body shop intake - captures service details that ride into the booking or message.',
    tree_refs: ['body_shop_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  oil_change_intake: {
    block_id: 'oil_change_intake',
    kind: 'conversation',
    description:
      'Oil change intake - captures service details that ride into the booking or message.',
    tree_refs: ['oil_change_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  car_wash_intake: {
    block_id: 'car_wash_intake',
    kind: 'conversation',
    description:
      'Car wash intake - captures service details that ride into the booking or message.',
    tree_refs: ['car_wash_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  salon_intake: {
    block_id: 'salon_intake',
    kind: 'conversation',
    description: 'Salon intake - captures service details that ride into the booking or message.',
    tree_refs: ['salon_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  barbershop_intake: {
    block_id: 'barbershop_intake',
    kind: 'conversation',
    description:
      'Barbershop intake - captures service details that ride into the booking or message.',
    tree_refs: ['barbershop_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  nail_salon_intake: {
    block_id: 'nail_salon_intake',
    kind: 'conversation',
    description:
      'Nail salon intake - captures service details that ride into the booking or message.',
    tree_refs: ['nail_salon_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  spa_intake: {
    block_id: 'spa_intake',
    kind: 'conversation',
    description: 'Spa intake - captures service details that ride into the booking or message.',
    tree_refs: ['spa_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  med_spa_intake: {
    block_id: 'med_spa_intake',
    kind: 'conversation',
    description: 'Med spa intake - captures service details that ride into the booking or message.',
    tree_refs: ['med_spa_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  lash_studio_intake: {
    block_id: 'lash_studio_intake',
    kind: 'conversation',
    description:
      'Lash studio intake - captures service details that ride into the booking or message.',
    tree_refs: ['lash_studio_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  plumber_intake: {
    block_id: 'plumber_intake',
    kind: 'conversation',
    description: 'Plumber intake - captures service details that ride into the booking or message.',
    tree_refs: ['plumber_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  electrician_intake: {
    block_id: 'electrician_intake',
    kind: 'conversation',
    description:
      'Electrician intake - captures service details that ride into the booking or message.',
    tree_refs: ['electrician_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  hvac_intake: {
    block_id: 'hvac_intake',
    kind: 'conversation',
    description: 'Hvac intake - captures service details that ride into the booking or message.',
    tree_refs: ['hvac_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  pest_control_intake: {
    block_id: 'pest_control_intake',
    kind: 'conversation',
    description:
      'Pest control intake - captures service details that ride into the booking or message.',
    tree_refs: ['pest_control_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  cleaning_intake: {
    block_id: 'cleaning_intake',
    kind: 'conversation',
    description:
      'Cleaning intake - captures service details that ride into the booking or message.',
    tree_refs: ['cleaning_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  landscaping_intake: {
    block_id: 'landscaping_intake',
    kind: 'conversation',
    description:
      'Landscaping intake - captures service details that ride into the booking or message.',
    tree_refs: ['landscaping_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  garage_door_intake: {
    block_id: 'garage_door_intake',
    kind: 'conversation',
    description:
      'Garage door intake - captures service details that ride into the booking or message.',
    tree_refs: ['garage_door_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  locksmith_intake: {
    block_id: 'locksmith_intake',
    kind: 'conversation',
    description:
      'Locksmith intake - captures service details that ride into the booking or message.',
    tree_refs: ['locksmith_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  personal_trainer_intake: {
    block_id: 'personal_trainer_intake',
    kind: 'conversation',
    description:
      'Personal trainer intake - captures service details that ride into the booking or message.',
    tree_refs: ['personal_trainer_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  yoga_studio_intake: {
    block_id: 'yoga_studio_intake',
    kind: 'conversation',
    description:
      'Yoga studio intake - captures service details that ride into the booking or message.',
    tree_refs: ['yoga_studio_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  tax_prep_intake: {
    block_id: 'tax_prep_intake',
    kind: 'conversation',
    description:
      'Tax prep intake - captures service details that ride into the booking or message.',
    tree_refs: ['tax_prep_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  tutoring_intake: {
    block_id: 'tutoring_intake',
    kind: 'conversation',
    description:
      'Tutoring intake - captures service details that ride into the booking or message.',
    tree_refs: ['tutoring_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  photography_intake: {
    block_id: 'photography_intake',
    kind: 'conversation',
    description:
      'Photography intake - captures service details that ride into the booking or message.',
    tree_refs: ['photography_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  real_estate_intake: {
    block_id: 'real_estate_intake',
    kind: 'conversation',
    description:
      'Real estate intake - captures service details that ride into the booking or message.',
    tree_refs: ['real_estate_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  insurance_intake: {
    block_id: 'insurance_intake',
    kind: 'conversation',
    description:
      'Insurance intake - captures service details that ride into the booking or message.',
    tree_refs: ['insurance_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  answering_service_intake: {
    block_id: 'answering_service_intake',
    kind: 'conversation',
    description:
      'Answering service intake - captures service details that ride into the booking or message.',
    tree_refs: ['answering_service_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  bakery_intake: {
    block_id: 'bakery_intake',
    kind: 'conversation',
    description: 'Bakery intake - captures service details that ride into the booking or message.',
    tree_refs: ['bakery_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
  catering_intake: {
    block_id: 'catering_intake',
    kind: 'conversation',
    description:
      'Catering intake - captures service details that ride into the booking or message.',
    tree_refs: ['catering_intake'],
    pairs_with: ['identity', 'booking', 'message'],
    sink: 'composed',
  },
};

/**
 * Front-desk presets for the 28 NEW verticals (auto_shop and salon already have
 * presets in presets.ts, where their intake block is added directly). Each
 * preset offers identity + its intake + the shared front-desk trees, and
 * forbids job/buy_service (a service business is neither hiring the owner nor
 * selling this product).
 */
export const VERTICAL_INTAKE_PRESETS: VerticalPresetDef[] = [
  {
    preset_id: 'mobile_tire_front_desk',
    vertical: 'mobile_tire',
    description:
      'Starter preset for mobile tire: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'mobile_tire_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'mobile_tire_intake' },
  },
  {
    preset_id: 'car_detailing_front_desk',
    vertical: 'car_detailing',
    description:
      'Starter preset for car detailing: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'car_detailing_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'car_detailing_intake' },
  },
  {
    preset_id: 'body_shop_front_desk',
    vertical: 'body_shop',
    description:
      'Starter preset for body shop: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'body_shop_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'body_shop_intake' },
  },
  {
    preset_id: 'oil_change_front_desk',
    vertical: 'oil_change',
    description:
      'Starter preset for oil change: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'oil_change_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'oil_change_intake' },
  },
  {
    preset_id: 'car_wash_front_desk',
    vertical: 'car_wash',
    description:
      'Starter preset for car wash: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'car_wash_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'car_wash_intake' },
  },
  {
    preset_id: 'barbershop_front_desk',
    vertical: 'barbershop',
    description:
      'Starter preset for barbershop: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'barbershop_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'barbershop_intake' },
  },
  {
    preset_id: 'nail_salon_front_desk',
    vertical: 'nail_salon',
    description:
      'Starter preset for nail salon: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'nail_salon_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'nail_salon_intake' },
  },
  {
    preset_id: 'spa_front_desk',
    vertical: 'spa',
    description:
      'Starter preset for spa: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: ['identity', 'spa_intake', 'booking', 'message', 'qa', 'schedule_change'],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'spa_intake' },
  },
  {
    preset_id: 'med_spa_front_desk',
    vertical: 'med_spa',
    description:
      'Starter preset for med spa: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'med_spa_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'med_spa_intake' },
  },
  {
    preset_id: 'lash_studio_front_desk',
    vertical: 'lash_studio',
    description:
      'Starter preset for lash studio: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'lash_studio_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'lash_studio_intake' },
  },
  {
    preset_id: 'plumber_front_desk',
    vertical: 'plumber',
    description:
      'Starter preset for plumber: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'plumber_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'plumber_intake' },
  },
  {
    preset_id: 'electrician_front_desk',
    vertical: 'electrician',
    description:
      'Starter preset for electrician: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'electrician_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'electrician_intake' },
  },
  {
    preset_id: 'hvac_front_desk',
    vertical: 'hvac',
    description:
      'Starter preset for hvac: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: ['identity', 'hvac_intake', 'booking', 'message', 'qa', 'schedule_change'],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'hvac_intake' },
  },
  {
    preset_id: 'pest_control_front_desk',
    vertical: 'pest_control',
    description:
      'Starter preset for pest control: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'pest_control_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'pest_control_intake' },
  },
  {
    preset_id: 'cleaning_front_desk',
    vertical: 'cleaning',
    description:
      'Starter preset for cleaning: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'cleaning_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'cleaning_intake' },
  },
  {
    preset_id: 'landscaping_front_desk',
    vertical: 'landscaping',
    description:
      'Starter preset for landscaping: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'landscaping_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'landscaping_intake' },
  },
  {
    preset_id: 'garage_door_front_desk',
    vertical: 'garage_door',
    description:
      'Starter preset for garage door: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'garage_door_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'garage_door_intake' },
  },
  {
    preset_id: 'locksmith_front_desk',
    vertical: 'locksmith',
    description:
      'Starter preset for locksmith: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'locksmith_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'locksmith_intake' },
  },
  {
    preset_id: 'personal_trainer_front_desk',
    vertical: 'personal_trainer',
    description:
      'Starter preset for personal trainer: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'personal_trainer_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'personal_trainer_intake' },
  },
  {
    preset_id: 'yoga_studio_front_desk',
    vertical: 'yoga_studio',
    description:
      'Starter preset for yoga studio: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'yoga_studio_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'yoga_studio_intake' },
  },
  {
    preset_id: 'tax_prep_front_desk',
    vertical: 'tax_prep',
    description:
      'Starter preset for tax prep: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'tax_prep_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'tax_prep_intake' },
  },
  {
    preset_id: 'tutoring_front_desk',
    vertical: 'tutoring',
    description:
      'Starter preset for tutoring: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'tutoring_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'tutoring_intake' },
  },
  {
    preset_id: 'photography_front_desk',
    vertical: 'photography',
    description:
      'Starter preset for photography: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'photography_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'photography_intake' },
  },
  {
    preset_id: 'real_estate_front_desk',
    vertical: 'real_estate',
    description:
      'Starter preset for real estate: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'real_estate_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'real_estate_intake' },
  },
  {
    preset_id: 'insurance_front_desk',
    vertical: 'insurance',
    description:
      'Starter preset for insurance: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'insurance_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'insurance_intake' },
  },
  {
    preset_id: 'answering_service_front_desk',
    vertical: 'answering_service',
    description:
      'Starter preset for answering service: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'answering_service_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'answering_service_intake' },
  },
  {
    preset_id: 'bakery_front_desk',
    vertical: 'bakery',
    description:
      'Starter preset for bakery: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'bakery_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'bakery_intake' },
  },
  {
    preset_id: 'catering_front_desk',
    vertical: 'catering',
    description:
      'Starter preset for catering: capture intake details, book work, take messages, answer questions, and handle schedule changes.',
    conversation_blocks: [
      'identity',
      'catering_intake',
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    policy_blocks: [],
    knowledge_blocks: [],
    outcome_blocks: [],
    forbidden_trees: ['job', 'buy_service'],
    defaults: { booking_mode: 'offer_once', primary_intake: 'catering_intake' },
  },
];
