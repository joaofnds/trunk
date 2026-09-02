import { capitalize, truncate } from "./utils";

// -- Greeting --

type TimeOfDay = "morning" | "afternoon" | "evening" | "night";

function getTimeOfDay(date: Date): TimeOfDay {
  const hour = date.getHours();
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";
  return "night";
}

export function greet(name: string, date: Date = new Date()): string {
  const timeOfDay = getTimeOfDay(date);
  const displayName = capitalize(name);
  return `Good ${timeOfDay}, ${displayName}! Welcome back.`;
}

// -- Math utilities --

export function add(...numbers: number[]): number {
  return numbers.reduce((sum, n) => sum + n, 0);
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

// -- Date formatting --

function getRelativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 30) return formatDateShort(date);
  if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
  if (diffHours > 0) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  if (diffMins > 0) return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
  return "just now";
}

function formatDateShort(date: Date): string {
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

export function formatDate(date: Date, relative: boolean = false): string {
  if (relative) return getRelativeTime(date);
  return formatDateShort(date);
}

// -- Display helpers --

export function formatUserCard(name: string, bio: string, joinDate: Date): string {
  const greeting = greet(name);
  const shortBio = truncate(bio, 80);
  const joined = formatDate(joinDate, true);
  return [greeting, `Bio: ${shortBio}`, `Joined: ${joined}`].join("\n");
}
