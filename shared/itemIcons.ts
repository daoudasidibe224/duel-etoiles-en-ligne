import type { Star } from "./contracts";
export interface ItemIcon {
  color: string;
  frame?: boolean;
  paths: { d: string; fill?: string; stroke?: string; width?: number }[];
  value?: string;
}
export const ITEM_ICONS: Record<Star["kind"], ItemIcon> = {
  star: {
    color: "#ffe09a",
    paths: [
      {
        d: "M32 12 38 25 52 27 42 37 45 51 32 44 19 51 22 37 12 27 26 25Z",
        fill: "#ffe09a",
        stroke: "#fff0c7",
      },
    ],
    frame: false,
  },
  gold: {
    color: "#ffbc38",
    paths: [
      {
        d: "M32 12 38 25 52 27 42 37 45 51 32 44 19 51 22 37 12 27 26 25Z",
        fill: "#ffbc38",
        stroke: "#ffe5a1",
      },
      {
        d: "M32 5V8M8 16 11 18M53 17 56 15",
        stroke: "#fff0c7",
      },
    ],
    value: "+3",
    frame: false,
  },
  sprint: {
    color: "#70daef",
    paths: [
      {
        d: "M35 10 17 35H30L25 54 49 27H35Z",
        fill: "#70daef",
        stroke: "#c3f4fa",
      },
      {
        d: "M12 20H20M9 27H17M8 43H15",
        stroke: "#70daef",
      },
    ],
  },
  multiplier: {
    color: "#bc9ff0",
    paths: [
      {
        d: "M14 15 17 21 24 22 19 27 20 34 14 30 8 34 9 27 4 22 11 21Z",
        fill: "#dac5ff",
        stroke: "#dac5ff",
      },
      {
        d: "M47 8 50 14 57 15 52 20 53 27 47 23 41 27 42 20 37 15 44 14Z",
        fill: "#bc9ff0",
        stroke: "#bc9ff0",
      },
    ],
    value: "×2",
  },
  shield: {
    color: "#82ddbf",
    paths: [
      {
        d: "M32 9 51 16V30C51 43 42 51 32 56 22 51 13 43 13 30V16Z",
        fill: "#245b50",
        stroke: "#a1f3d7",
      },
      {
        d: "M32 16 44 21V30C44 38 39 43 32 48 25 43 20 38 20 30V21Z",
        stroke: "#82ddbf",
      },
      {
        d: "M25 31 30 36 39 26",
        stroke: "#effff5",
        width: 4,
      },
    ],
  },
  magnet: {
    color: "#eea6c9",
    paths: [
      {
        d: "M14 12V35C14 59 50 59 50 35V12H38V35C38 44 26 44 26 35V12Z",
        fill: "#a35d87",
        stroke: "#ffcae2",
      },
      {
        d: "M14 12H26V23H14ZM38 12H50V23H38Z",
        fill: "#fff0f7",
        stroke: "#fff0f7",
      },
      {
        d: "M6 29 10 31M54 31 58 29",
        stroke: "#eea6c9",
      },
    ],
  },
  meteor: {
    color: "#ff8065",
    paths: [
      {
        d: "M13 20 5 12M19 13 14 5M27 11 25 3",
        stroke: "#ffb582",
        width: 4,
      },
      {
        d: "M32 16 46 17 55 28 52 43 42 52 25 50 15 37 19 23Z",
        fill: "#985747",
        stroke: "#ffc094",
      },
      {
        d: "M28 25C18 23 20 34 28 33 34 32 34 26 28 25ZM43 35C36 33 35 43 42 43 49 44 50 36 43 35Z",
        fill: "#593832",
        stroke: "#d88767",
      },
    ],
    value: "−3",
  },
  barrier: {
    color: "#f1a373",
    paths: [
      {
        d: "M9 22H55V51H9Z",
        fill: "#875d44",
        stroke: "#ffd0a0",
      },
      {
        d: "M10 40 26 23M24 50 48 23M44 50 54 38",
        stroke: "#f1a373",
        width: 6,
      },
      {
        d: "M5 56H59",
        stroke: "#e0d8bc",
      },
    ],
    value: "−2",
  },
  slime: {
    color: "#b6dc62",
    paths: [
      {
        d: "M9 46C7 36 18 31 28 35 31 23 45 25 47 37 58 36 60 48 49 53 34 58 16 55 9 46Z",
        fill: "#86a548",
        stroke: "#d0eb93",
      },
      {
        d: "M18 39 25 37M38 34 42 38",
        stroke: "#e2f5ab",
      },
      {
        d: "M32 8V24M25 18 32 25 39 18",
        stroke: "#eaffc3",
        width: 4,
      },
    ],
  },
};
