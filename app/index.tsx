// app/index.tsx
import { Redirect } from 'expo-router';

const Page = () => {
  return <Redirect href="/(root)/(tabs)/home" />;
};

export default Page;
