// app/index.tsx
// import { useAuth } from '@clerk/clerk-expo';
import { Redirect } from 'expo-router';

const Page = () => {
  // const { isLoaded } = useAuth();

  // if (!isLoaded) {
  // Optionally, you can display a loading indicator here
  // return null;
  // }

  // Always redirect to Home upon app load
  return <Redirect href="/(root)/(tabs)/home" />;
};

export default Page;
