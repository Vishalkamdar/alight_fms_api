/**
 * The complete current list of Indian States and Union Territories — a
 * fixed, rarely-changing enumeration, so it's kept as a plain constant
 * rather than an admin-editable master collection (unlike NodeType, which
 * genuinely needs to be configurable). The State field on a Beneficiary is
 * validated against this exact list, never free text.
 */
export const INDIAN_STATES = [
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chhattisgarh",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
] as const;

export const INDIAN_UNION_TERRITORIES = [
  "Andaman and Nicobar Islands",
  "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi",
  "Jammu and Kashmir",
  "Ladakh",
  "Lakshadweep",
  "Puducherry",
] as const;

export const INDIAN_STATES_AND_UTS = [...INDIAN_STATES, ...INDIAN_UNION_TERRITORIES] as const;
export type IndianStateOrUt = (typeof INDIAN_STATES_AND_UTS)[number];
