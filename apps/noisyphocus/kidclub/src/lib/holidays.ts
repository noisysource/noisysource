import { isSameDay } from 'date-fns';

let holidays: Date[] = [];

export const initializeHolidays = async (year: number) => {
  try {
    const response = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/PT`);
    const data = await response.json();
    holidays = data.map((holiday: any) => new Date(holiday.date));
  } catch (error) {
    console.error('Error fetching holidays:', error);
  }
};

export const isHoliday = (date: Date) => {
  return holidays.some(holiday => isSameDay(holiday, date));
};