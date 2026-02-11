import { LeverageUpdateTool } from '@/components/dashboard/LeverageUpdateTool';

const LeverageUpdatePage = () => {
  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto">
        <div className="py-6">
          <h1 className="text-3xl font-bold mb-2">Leverage Update Tool</h1>
          <p className="text-muted-foreground mb-6">
            Bulk update account leverage. Upload your account list and set the new leverage value.
          </p>
        </div>
        <LeverageUpdateTool />
      </div>
    </div>
  );
};

export default LeverageUpdatePage;
