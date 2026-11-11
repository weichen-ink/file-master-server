const year = String(new Date().getFullYear());
const yearElement = document.getElementById("current-year");
if (yearElement) {
  yearElement.textContent = year;
  yearElement.dateTime = year;
}
