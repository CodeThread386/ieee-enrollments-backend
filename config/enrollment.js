/**
 * Enrollment content: domains and application-form questions.
 *
 * The frontend renders the application form from this data (served by
 * `GET /api/user/application/form`), so the board can change wording or add
 * questions here without touching or redeploying the frontend.
 */

/** Domains a candidate can apply for. Tasks and slots are tagged with these. */
export const DOMAINS = [
  "App Development",
  "Web Development",
  "Electronics",
  "Machine Learning",
  "Design",
  "Video Editing",
  "Cyber Security",
  "Competitive Coding",
  "Management",
];

/**
 * Open-ended questions shown after the profile and domain steps.
 * `id` is stored with each answer, so never reuse an id for a different question.
 */
export const APPLICATION_QUESTIONS = [
  {
    id: "whyIeee",
    label: "Why do you want to join IEEE-VIT?",
    required: true,
    maxLength: 800,
  },
  {
    id: "currentSkills",
    label:
      "Which technologies or tools have you worked with so far? (No prior experience is completely fine - just tell us.)",
    required: true,
    maxLength: 800,
  },
  {
    id: "exploreNext",
    label: "What is one technology or skill you want to explore next, and why?",
    required: true,
    maxLength: 800,
  },
  {
    id: "pastExperience",
    label:
      "Tell us about any project, hackathon, competition or event you have been part of. What problems did you face and how did you solve them?",
    required: false,
    maxLength: 1200,
  },
  {
    id: "commitment",
    label:
      "How many hours per week can you realistically commit to the chapter alongside your academics?",
    required: true,
    maxLength: 300,
  },
];

/**
 * Situational management questions. Each candidate gets exactly one, picked
 * deterministically from their user id so it never changes between visits.
 */
export const MANAGEMENT_QUESTIONS = [
  {
    id: 1,
    text: "Two key members of your team refuse to collaborate because of personal differences. The project deadline is close and their behaviour is hurting productivity. How would you handle this?",
  },
  {
    id: 2,
    text: "During a live online coding contest your team is hosting, the platform crashes and participants cannot submit. The chat is flooded with complaints. How would you communicate and manage the crisis?",
  },
  {
    id: 3,
    text: "You are caught in a disagreement between two board members while a faculty coordinator keeps calling, asking for someone to speak to them urgently. How would you manage the situation?",
  },
  {
    id: 4,
    text: "Two days before a flagship event, the main sponsor pulls out and the budget drops by 40%. What would you do in the next 48 hours?",
  },
];

/** Interview outcomes an admin can record for a candidate. */
export const INTERVIEW_STATUSES = [
  "pending",
  "selected",
  "rejected",
  "on-hold",
  "no-show",
];

/** Picks the management question for a user in a stable way. */
export function managementQuestionFor(userId) {
  const key = String(userId);
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return MANAGEMENT_QUESTIONS[hash % MANAGEMENT_QUESTIONS.length];
}
