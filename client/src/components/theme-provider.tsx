import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";
const ThemeCtx = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({ theme: "dark", setTheme: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    return (localStorage.getItem("vcms-theme") as Theme) || "dark";
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("vcms-theme", theme);
  }, [theme]);

  const setTheme = (t: Theme) => setThemeState(t);

  return <ThemeCtx.Provider value={{ theme, setTheme }}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  return useContext(ThemeCtx);
}
