//constants/index.ts

export const icons = {
  chat: require('@/assets/icons/chat.png'),
  home: require('@/assets/icons/home.png'),
  profile: require('@/assets/icons/profile.png'),
  list: require('@/assets/icons/list.png'),
  email: require('@/assets/icons/email.png'),
  lock: require('@/assets/icons/lock.png'),
  person: require('@/assets/icons/person.png'),
  google: require('@/assets/icons/google.png'),
};
import Constants from 'expo-constants';
export const images = {};

export const BACKEND_URL = Constants.expoConfig?.extra?.BACKEND_URL;
