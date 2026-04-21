import { Timestamp } from "firebase/firestore";
import { Role } from "./Roles";

export interface AppUser {
  uid: string;
  email: string;
  name: string;
  createdAt: Timestamp;
  lastLogin?: Timestamp;
  active?: boolean;
  roles: Partial<Record<Role, boolean>>;
}