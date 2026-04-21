export const safeDate = (date: any): Date => {
  if (!date) {
    return new Date();
  }
  if (typeof date.toDate === 'function') {
    return date.toDate();
  }
  if (typeof date === 'string') {
    return new Date(date);
  }
  return date;
};
