/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'media', // Enable dark mode based on system preference
  presets: [require('nativewind/preset')],
  content: ['./app/**/*.{js,jsx,ts,tsx}', './components/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        Jakarta: ['Jakarta', 'sans-serif'],
        JakartaBold: ['Jakarta-Bold', 'sans-serif'],
        JakartaExtraBold: ['Jakarta-ExtraBold', 'sans-serif'],
        JakartaExtraLight: ['Jakarta-ExtraLight', 'sans-serif'],
        JakartaLight: ['Jakarta-Light', 'sans-serif'],
        JakartaMedium: ['Jakarta-Medium', 'sans-serif'],
        JakartaSemiBold: ['Jakarta-SemiBold', 'sans-serif'],
      },
      colors: {
        // Add theme-specific colors
        theme: {
          light: {
            background: '#FCFCFC',
            text: {
              primary: '#000000',
              secondary: '#666666',
            },
            input: {
              background: '#F0F0F0',
              text: '#333333',
              placeholder: '#666666',
            },
            //Buttons google, signup, login
            google: {
              background: '#0D0D0D',
              text: '#FFFFFF',
              border: '#0D0D0D',
            },
            signup: {
              background: '#E6E6E6',
              text: '#0D0D0D',
              border: '#E6E6E6',
            },
            login: {
              background: '#E6E6E6',
              text: '#0D0D0D',
              border: '#DADADA',
            },
          },
          dark: {
            background: '#0D0D0D',
            text: {
              primary: '#FFFFFF',
              secondary: '#9BA1A6',
            },
            input: {
              background: '#242424',
              text: '#E6E6E6',
              placeholder: '#E6E6E6',
            },
            //Buttons google, signup, login

            google: {
              background: '#E6E6E6',
              text: '#333333',
              border: '#E6E6E6',
            },
            signup: {
              background: '#2F2F2F',
              text: '#E6E6E6',
              border: '#2F2F2F',
            },
            login: {
              background: '#0D0D0D',
              text: '#E6E6E6',
              border: '#4E4E4E',
            },
          },
        },

        // Keep existing color palettes unchanged
        primary: {
          100: '#F5F8FF',
          200: '#EBF4FF',
          300: '#C3D9FF',
          400: '#9BBFFF',
          500: '#0286FF',
          600: '#6A85E6',
          700: '#475A99',
          800: '#364573',
          900: '#242B4D',
        },
        secondary: {
          100: '#F8F8F8',
          200: '#F1F1F1',
          300: '#D9D9D9',
          400: '#C2C2C2',
          500: '#AAAAAA',
          600: '#999999',
          700: '#666666',
          800: '#4D4D4D',
          900: '#333333',
        },
        success: {
          100: '#F0FFF4',
          200: '#C6F6D5',
          300: '#9AE6B4',
          400: '#68D391',
          500: '#38A169',
          600: '#2F855A',
          700: '#276749',
          800: '#22543D',
          900: '#1C4532',
        },
        danger: {
          100: '#FFF5F5',
          200: '#FED7D7',
          300: '#FEB2B2',
          400: '#FC8181',
          500: '#F56565',
          600: '#E53E3E',
          700: '#C53030',
          800: '#9B2C2C',
          900: '#742A2A',
        },
        warning: {
          100: '#FFFBEB',
          200: '#FEF3C7',
          300: '#FDE68A',
          400: '#FACC15',
          500: '#EAB308',
          600: '#CA8A04',
          700: '#A16207',
          800: '#854D0E',
          900: '#713F12',
        },
        general: {
          100: '#CED1DD',
          200: '#858585',
          300: '#EEEEEE',
          400: '#0CC25F',
          500: '#F6F8FA',
          600: '#E6F3FF',
          700: '#EBEBEB',
          800: '#ADADAD',
        },
      },
    },
  },
  plugins: [],
};
