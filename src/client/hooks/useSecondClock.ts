import { useEffect, useState } from "react";

/** Now, re-read every second while mounted: for a clock that counts up in
 *  front of the reader. Age labels that change by the minute use useNow. */
export function useSecondClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
